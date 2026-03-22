import { NextRequest } from 'next/server'
import { fetchOrder } from '@/lib/scraper'

// Node.js runtime — 60s timeout on Vercel free tier (vs 10s for Edge)
export const runtime = 'nodejs'
export const maxDuration = 60

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { subdomain, slug, concurrency = 5, mode = 'date' } = body

  const encoder = new TextEncoder()
  const stream  = new TransformStream()
  const writer  = stream.writable.getWriter()

  const send = (type: string, data: any) => {
    try { writer.write(encoder.encode(`data: ${JSON.stringify({ type, ...data })}\n\n`)) } catch {}
  }

  const heartbeat = setInterval(() => {
    try { writer.write(encoder.encode(': ping\n\n')) } catch {}
  }, 4000)

  ;(async () => {
    try {
      const orders: any[] = []
      let scanned = 0

      if (mode === 'manual') {
        const { startId, endId, useAuto = false, stopAfter = 200 } = body
        const maxId = useAuto ? startId + 50000 : endId
        send('log', { msg: `Manual: #${startId} → ${useAuto ? 'auto' : '#'+endId} | ${concurrency}x`, cls: 'info' })
        send('start', { total: useAuto ? 0 : maxId - startId + 1 })
        let misses = 0, matched = 0, stopped = false

        for (let base = startId; base <= maxId && !stopped; base += concurrency) {
          const ids: number[] = []
          for (let id = base; id <= Math.min(base + concurrency - 1, maxId); id++) ids.push(id)
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
          send('progress', { done: scanned, total: useAuto ? 0 : maxId - startId + 1, found: matched })
          await sleep(250)
        }
        send('done', { matched: orders.length, scanned, runId: Date.now().toString() })

      } else {
        const { fromDate, toDate, anchorId, anchorDate, regressionPoints = [],
                scanStart: resumeFrom, scanEnd: resumeTo } = body

        let scanStart: number
        let scanEnd: number

        if (resumeFrom && resumeTo) {
          // Resuming a chunk
          scanStart = resumeFrom
          scanEnd   = resumeTo
          send('log', { msg: `Chunk: #${scanStart}–#${scanEnd}`, cls: 'info' })
          send('start', { total: resumeTo - resumeFrom + 1, scanStart, scanEnd })
        } else {
          // First call — find boundaries by walking from anchor
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
          const total = scanEnd - scanStart + 1
          send('log', { msg: `Range: #${scanStart}–#${scanEnd} (${total} IDs)`, cls: 'ok' })
          send('range', { scanStart, scanEnd, total })
          send('start', { total, scanStart, scanEnd })
        }

        // Scan a safe chunk that fits within 50s
        // At 5 concurrency + 250ms/batch = 20 IDs/sec → 50s = 1000 IDs max safely
        const SAFE_CHUNK = 800
        const chunkEnd = Math.min(scanStart + SAFE_CHUNK - 1, scanEnd)
        let matched = 0, rlStreak = 0

        for (let base = scanStart; base <= chunkEnd; base += concurrency) {
          const ids: number[] = []
          for (let id = base; id <= Math.min(base + concurrency - 1, chunkEnd); id++) ids.push(id)
          const fetched = await Promise.all(ids.map(id => fetchOrder(subdomain, id)))
          for (let i = 0; i < ids.length; i++) {
            const o = fetched[i]; scanned++
            if (o === 'rl') { rlStreak++; continue }
            rlStreak = Math.max(0, rlStreak - 1)
            if (o && o.slug === slug && o.dateYMD && o.dateYMD >= fromDate && o.dateYMD <= toDate) {
              orders.push(o); matched++
              send('order', { order: o })
              send('log', { msg: `#${ids[i]}  ${o.orderDate}  ${o.value}  ${o.payment}  ${o.location}  ${o.pincode}`, cls: 'ok' })
            }
          }
          send('progress', { done: scanned, total: scanEnd - (body.originalStart || scanStart) + 1, found: matched })
          await sleep(rlStreak > 3 ? Math.min(rlStreak * 1500, 10000) : 250)
        }

        if (chunkEnd < scanEnd) {
          send('chunk_done', {
            nextStart: chunkEnd + 1,
            scanEnd,
            originalStart: body.originalStart || scanStart,
            fromDate, toDate,
            runId: body.runId || Date.now().toString(),
            chunkOrders: orders
          })
        } else {
          send('done', { matched: orders.length, scanned, runId: body.runId || Date.now().toString() })
        }
      }
    } catch (err: any) {
      send('error', { msg: err.message })
      send('done', { matched: 0, scanned: 0, runId: Date.now().toString() })
    } finally {
      clearInterval(heartbeat)
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
