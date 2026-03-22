import { NextRequest } from 'next/server'
import { fetchOrder } from '@/lib/scraper'

export const runtime = 'nodejs'
export const maxDuration = 60

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// Safe IDs per 60s call: at 5 concurrency, 250ms/batch = 20 IDs/s × 50s = 1000 IDs
// Use 900 to leave buffer for boundary detection overhead
const CHUNK = 900

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { subdomain, slug, concurrency = 5, mode = 'date',
          fromDate, toDate, scanStart: resumeFrom, scanEnd: resumeTo,
          startId, endId, useAuto, stopAfter = 200,
          originalStart, runId, anchorId, anchorDate,
          regressionPoints = [] } = body

  const encoder = new TextEncoder()
  const stream  = new TransformStream()
  const writer  = stream.writable.getWriter()

  const send = (type: string, data: any) => {
    try { writer.write(encoder.encode(`data: ${JSON.stringify({ type, ...data })}\n\n`)) } catch {}
  }

  const ping = setInterval(() => {
    try { writer.write(encoder.encode(': ping\n\n')) } catch {}
  }, 4000)

  ;(async () => {
    try {
      const orders: any[] = []
      let scanned = 0, matched = 0, rlStreak = 0

      // ── Helper: scan a range of IDs ──────────────────
      const scanRange = async (from: number, to: number, totalSpan: number, dateFilter?: {from:string,to:string}) => {
        for (let base = from; base <= to; base += concurrency) {
          const ids: number[] = []
          for (let id = base; id <= Math.min(base + concurrency - 1, to); id++) ids.push(id)
          const fetched = await Promise.all(ids.map(id => fetchOrder(subdomain, id)))
          for (let i = 0; i < ids.length; i++) {
            const o = fetched[i]; scanned++
            if (o === 'rl') { rlStreak++; continue }
            rlStreak = Math.max(0, rlStreak - 1)
            if (o && o.slug === slug) {
              if (!dateFilter || (o.dateYMD && o.dateYMD >= dateFilter.from && o.dateYMD <= dateFilter.to)) {
                orders.push(o); matched++
                send('order', { order: o })
                send('log', { msg: `#${ids[i]}  ${o.orderDate}  ${o.value}  ${o.payment}  ${o.location}${o.pincode?' '+o.pincode:''}`, cls: 'ok' })
              }
            }
          }
          send('progress', { done: (originalStart||from) + scanned - 1, total: totalSpan, found: matched })
          await sleep(rlStreak > 3 ? Math.min(rlStreak * 1500, 10000) : 250)
        }
      }

      if (mode === 'manual') {
        const chunkStart = resumeFrom || startId
        const chunkEnd   = resumeTo   || (useAuto ? startId + 50000 : endId)
        const totalSpan  = (useAuto ? 0 : (endId - startId + 1))
        const thisEnd    = Math.min(chunkStart + CHUNK - 1, chunkEnd)

        if (!resumeFrom) {
          send('log', { msg: `Manual: #${startId} → ${useAuto ? 'auto' : '#'+endId} | ${concurrency}x`, cls: 'info' })
          send('start', { total: totalSpan })
        }

        let misses = 0, stopped = false
        for (let base = chunkStart; base <= thisEnd && !stopped; base += concurrency) {
          const ids: number[] = []
          for (let id = base; id <= Math.min(base + concurrency - 1, thisEnd); id++) ids.push(id)
          const fetched = await Promise.all(ids.map(id => fetchOrder(subdomain, id)))
          for (let i = 0; i < ids.length && !stopped; i++) {
            const o = fetched[i]; scanned++
            if (o && o !== 'rl' && o.slug === slug) {
              orders.push(o); matched++; misses = 0
              send('order', { order: o })
              send('log', { msg: `#${ids[i]}  ${o.orderDate}  ${o.value}  ${o.payment}  ${o.location}`, cls: 'ok' })
            } else if (o !== 'rl') misses++
            if (useAuto && misses >= stopAfter) {
              send('log', { msg: `Auto-stopped: ${stopAfter} consecutive misses`, cls: 'info' })
              stopped = true
            }
          }
          send('progress', { done: base - startId + scanned, total: totalSpan, found: matched })
          await sleep(250)
        }

        if (!stopped && thisEnd < chunkEnd) {
          send('chunk_done', {
            mode: 'manual', nextStart: thisEnd + 1, scanEnd: chunkEnd,
            startId, endId, useAuto, stopAfter,
            runId: runId || Date.now().toString(), chunkOrders: orders
          })
        } else {
          send('done', { matched: orders.length, scanned, runId: runId || Date.now().toString() })
        }

      } else {
        // ── Date scan ────────────────────────────────────
        let scanStart: number
        let scanEnd: number
        let totalSpan: number

        if (resumeFrom && resumeTo) {
          scanStart = resumeFrom
          scanEnd   = resumeTo
          totalSpan = resumeTo - (originalStart || resumeFrom) + 1
          send('log', { msg: `Continuing from #${scanStart} (${matched} found so far)...`, cls: 'info' })
        } else {
          send('log', { msg: `Scan: ${fromDate} → ${toDate}`, cls: 'info' })
          send('log', { msg: `Finding boundaries from #${anchorId} = ${anchorDate}...`, cls: 'info' })

          const pts = [{ date: anchorDate, id: anchorId }, ...regressionPoints]
            .filter((p: any) => p.date && p.id > 0)
            .sort((a: any, b: any) => a.date.localeCompare(b.date))

          const walk = async (targetDate: string) => {
            let ref = pts[0]
            for (const p of pts) {
              if (Math.abs(new Date(p.date+'T00:00:00').getTime() - new Date(targetDate+'T00:00:00').getTime()) <
                  Math.abs(new Date(ref.date+'T00:00:00').getTime() - new Date(targetDate+'T00:00:00').getTime())) ref = p
            }
            const forward = targetDate >= ref.date
            let lo = ref.id, hi = ref.id
            for (let i = 1; i <= 300; i++) {
              const pid = forward ? ref.id + i*500 : Math.max(1, ref.id - i*500)
              const o = await fetchOrder(subdomain, pid)
              if (o && o !== 'rl' && o.slug === slug && o.dateYMD) {
                send('log', { msg: `  #${o.orderId} = ${o.orderDate}`, cls: 'info' })
                if (forward) { if (o.dateYMD >= targetDate) { hi = o.orderId; break }; lo = o.orderId }
                else         { if (o.dateYMD <= targetDate) { lo = o.orderId; break }; hi = o.orderId }
              }
              await sleep(80)
            }
            return { lo, hi }
          }

          const fromB = await walk(fromDate)
          const toB   = await walk(toDate)
          scanStart = Math.max(1, fromB.lo - 200)
          scanEnd   = toB.hi + 200
          totalSpan = scanEnd - scanStart + 1
          send('log', { msg: `Range: #${scanStart}–#${scanEnd} (${totalSpan} IDs)`, cls: 'ok' })
          send('range', { scanStart, scanEnd, total: totalSpan })
          send('start', { total: totalSpan, scanStart, scanEnd })
        }

        const chunkEnd = Math.min(scanStart + CHUNK - 1, scanEnd)
        await scanRange(scanStart, chunkEnd, totalSpan, { from: fromDate, to: toDate })

        if (chunkEnd < scanEnd) {
          send('chunk_done', {
            mode: 'date', nextStart: chunkEnd + 1, scanEnd,
            originalStart: originalStart || scanStart,
            fromDate, toDate,
            runId: runId || Date.now().toString(),
            chunkOrders: orders
          })
        } else {
          send('done', { matched: orders.length, scanned, runId: runId || Date.now().toString() })
        }
      }

    } catch (err: any) {
      send('error', { msg: err.message })
      send('done', { matched: 0, scanned: 0, runId: runId || Date.now().toString() })
    } finally {
      clearInterval(ping)
      writer.close().catch(() => {})
    }
  })()

  return new Response(stream.readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    }
  })
}
