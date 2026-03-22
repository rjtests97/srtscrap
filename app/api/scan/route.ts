import { NextRequest } from 'next/server'
import { fetchOrder } from '@/lib/scraper'

export const runtime = 'nodejs'
export const maxDuration = 60

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const CHUNK = 1000 // IDs per call

export async function POST(req: NextRequest) {
  const body = await req.json()
  const {
    subdomain, slug, concurrency = 5,
    fromDate, toDate,
    scanStart, scanEnd, originalStart, totalSpan, runId,
    startId, endId, useAuto = false, stopAfter = 200,
    anchorId, anchorDate, regressionPoints = [],
    mode = 'date'
  } = body

  const encoder = new TextEncoder()
  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()

  const send = (type: string, data: any) => {
    try { writer.write(encoder.encode(`data: ${JSON.stringify({ type, ...data })}\n\n`)) } catch {}
  }
  const ping = setInterval(() => {
    try { writer.write(encoder.encode(': ping\n\n')) } catch {}
  }, 5000)

  ;(async () => {
    try {
      const orders: any[] = []
      let scanned = 0, matched = 0, rlStreak = 0

      // ── Walk from a known point to bracket a target date ──
      const walk = async (targetDate: string, label: string) => {
        const pts = [{ date: anchorDate, id: anchorId }, ...regressionPoints]
          .filter((p: any) => p.date && p.id > 0)
          .sort((a: any, b: any) => a.date.localeCompare(b.date))

        // Pick closest known point to target
        let ref = pts[0]
        for (const p of pts) {
          if (Math.abs(new Date(p.date + 'T00:00:00').getTime() - new Date(targetDate + 'T00:00:00').getTime()) <
              Math.abs(new Date(ref.date + 'T00:00:00').getTime() - new Date(targetDate + 'T00:00:00').getTime())) ref = p
        }

        send('log', { msg: `  Walk ${label}: from #${ref.id} (${ref.date}) → ${targetDate}`, cls: 'info' })

        const forward = targetDate >= ref.date
        let lo = ref.id, hi = ref.id

        for (let i = 1; i <= 500; i++) {
          const pid = forward ? ref.id + i * 500 : Math.max(1, ref.id - i * 500)
          if (pid < 1) break
          const o = await fetchOrder(subdomain, pid)
          if (o && o !== 'rl' && o.slug === slug && o.dateYMD) {
            send('log', { msg: `    #${o.orderId} = ${o.orderDate}`, cls: 'info' })
            if (forward) {
              if (o.dateYMD >= targetDate) { hi = o.orderId; break }
              lo = o.orderId
            } else {
              if (o.dateYMD <= targetDate) { lo = o.orderId; break }
              hi = o.orderId
            }
          }
          // No delay — walk as fast as possible
        }
        return { lo, hi }
      }

      // ── Date scan ──────────────────────────────────────────
      if (mode === 'date') {
        let ss: number, se: number, ts: number

        if (scanStart && scanEnd) {
          // Resuming a chunk — no boundary detection needed
          ss = scanStart; se = scanEnd
          ts = totalSpan || (se - ss + 1)
        } else {
          // First call — detect boundaries sequentially (not parallel, to avoid rate limits)
          send('log', { msg: `Finding boundaries for ${fromDate} → ${toDate}...`, cls: 'info' })
          const fromB = await walk(fromDate, 'start')
          const toB   = await walk(toDate,   'end')
          ss = Math.max(1, fromB.lo - 100)
          se = toB.hi + 100
          ts = se - ss + 1
          send('log', { msg: `Range: #${ss}–#${se} (${ts} IDs)`, cls: 'ok' })
          send('range', { scanStart: ss, scanEnd: se, total: ts })
        }

        send('start', { total: ts, scanStart: ss, scanEnd: se })

        const chunkEnd = Math.min(ss + CHUNK - 1, se)
        send('log', { msg: `Scanning #${ss}–#${chunkEnd}...`, cls: 'info' })

        for (let base = ss; base <= chunkEnd; base += concurrency) {
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
          const globalDone = (originalStart || ss) + scanned
          send('progress', { done: globalDone, total: ts, found: matched })
          await sleep(rlStreak > 3 ? Math.min(rlStreak * 1500, 10000) : 200)
        }

        if (chunkEnd < se) {
          send('chunk_done', {
            mode: 'date',
            nextStart: chunkEnd + 1, scanEnd: se,
            originalStart: originalStart || ss,
            totalSpan: ts, fromDate, toDate,
            runId: runId || Date.now().toString(),
            chunkOrders: orders
          })
        } else {
          send('done', { matched: orders.length, scanned, runId: runId || Date.now().toString() })
        }

      // ── Manual scan ────────────────────────────────────────
      } else {
        const ss = scanStart || startId
        const se = scanEnd   || (useAuto ? startId + 50000 : endId)
        const ts = totalSpan || (useAuto ? 0 : endId - startId + 1)
        const chunkEnd = Math.min(ss + CHUNK - 1, se)

        send('log', { msg: `Manual #${ss}–#${chunkEnd} | ${concurrency}x`, cls: 'info' })
        send('start', { total: ts })

        let misses = 0, stopped = false
        for (let base = ss; base <= chunkEnd && !stopped; base += concurrency) {
          const ids: number[] = []
          for (let id = base; id <= Math.min(base + concurrency - 1, chunkEnd); id++) ids.push(id)
          const fetched = await Promise.all(ids.map(id => fetchOrder(subdomain, id)))
          for (let i = 0; i < ids.length && !stopped; i++) {
            const o = fetched[i]; scanned++
            if (o && o !== 'rl' && o.slug === slug) {
              orders.push(o); matched++; misses = 0
              send('order', { order: o })
              send('log', { msg: `#${ids[i]}  ${o.orderDate}  ${o.value}  ${o.payment}  ${o.location}`, cls: 'ok' })
            } else if (o !== 'rl') {
              misses++
            }
            if (useAuto && misses >= stopAfter) {
              send('log', { msg: `Auto-stopped: ${stopAfter} consecutive misses`, cls: 'info' })
              stopped = true
            }
          }
          const globalDone = (originalStart || ss) + scanned
          send('progress', { done: globalDone, total: ts, found: matched })
          await sleep(200)
        }

        if (!stopped && chunkEnd < se) {
          send('chunk_done', {
            mode: 'manual',
            nextStart: chunkEnd + 1, scanEnd: se,
            originalStart: originalStart || ss,
            totalSpan: ts, startId, endId, useAuto, stopAfter,
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

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    }
  })
}
