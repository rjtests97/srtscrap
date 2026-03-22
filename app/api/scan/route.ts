import { NextRequest } from 'next/server'
import { fetchOrder } from '@/lib/scraper'

export const runtime = 'edge'
export const maxDuration = 300

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

  // Heartbeat — keeps SSE alive and prevents Vercel/browser timeouts
  const heartbeatInterval = setInterval(() => {
    try { writer.write(encoder.encode(': heartbeat\n\n')) } catch {}
  }, 5000)

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
            if (useAuto && misses >= stopAfter) { send('log', { msg: `Auto-stopped: ${stopAfter} consecutive misses`, cls: 'info' }); stopped = true }
          }
          send('progress', { done: scanned, total: useAuto ? 0 : maxId - startId + 1, found: matched })
          await sleep(300)
        }
        send('done', { matched: orders.length, scanned, runId: Date.now().toString() })

      } else {
        // ── Date scan ────────────────────────────────────────
        const { fromDate, toDate, anchorId, anchorDate, regressionPoints = [], scanStart: resumeFrom } = body

        // If resuming a chunked scan, skip boundary detection
        let scanStart: number
        let scanEnd: number
        const totalFromBody = body.scanEnd - body.scanStart + 1

        if (resumeFrom && body.scanEnd) {
          // Resuming from a previous chunk
          scanStart = resumeFrom
          scanEnd   = body.scanEnd
          send('log', { msg: `Resuming from #${scanStart}`, cls: 'info' })
          send('start', { total: totalFromBody, scanStart, scanEnd })
        } else {
          // First call — find boundaries
          send('log', { msg: `Scan: ${fromDate} → ${toDate}`, cls: 'info' })
          send('log', { msg: `Finding boundaries from anchor #${anchorId} = ${anchorDate}...`, cls: 'info' })

          const pts = [{ date: anchorDate, id: anchorId }, ...regressionPoints]
            .filter((p: any) => p.date && p.id > 0)
            .sort((a: any, b: any) => a.date.localeCompare(b.date))

          const walkToDate = async (targetDate: string) => {
            let ref = pts[0]
            for (const p of pts) {
              if (Math.abs(new Date(p.date+'T00:00:00').getTime() - new Date(targetDate+'T00:00:00').getTime()) <
                  Math.abs(new Date(ref.date+'T00:00:00').getTime() - new Date(targetDate+'T00:00:00').getTime())) ref = p
            }
            const forward = targetDate >= ref.date
            const STEP = 500
            let lo = ref.id, hi = ref.id
            for (let i = 1; i <= 400; i++) {
              const probeId = forward ? ref.id + i * STEP : Math.max(1, ref.id - i * STEP)
              const o = await fetchOrder(subdomain, probeId)
              if (o && o !== 'rl' && o.slug === slug && o.dateYMD) {
                send('log', { msg: `  #${o.orderId} = ${o.orderDate}`, cls: 'info' })
                if (forward) { if (o.dateYMD >= targetDate) { hi = o.orderId; break }; lo = o.orderId }
                else         { if (o.dateYMD <= targetDate) { lo = o.orderId; break }; hi = o.orderId }
              }
              await sleep(80)
            }
            return { lo, hi }
          }

          const fromB = await walkToDate(fromDate)
          const toB   = await walkToDate(toDate)
          scanStart = Math.max(1, fromB.lo - 300)
          scanEnd   = toB.hi + 300
          const total = scanEnd - scanStart + 1
          send('log', { msg: `Range: #${scanStart}–#${scanEnd} (${total} IDs)`, cls: 'ok' })
          send('start', { total, scanStart, scanEnd })
          // Tell client the full range for chunking
          send('range', { scanStart, scanEnd, total })
        }

        let matched = 0, rlStreak = 0
        const CHUNK_SIZE = 2000 // IDs per server call — safe for 5min timeout at 5x concurrency
        const chunkEnd = Math.min(scanStart + CHUNK_SIZE - 1, scanEnd)

        send('log', { msg: `Scanning #${scanStart}–#${chunkEnd} of #${scanEnd}...`, cls: 'info' })

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
          send('progress', { done: scanned, total: scanEnd - (body.scanStart || scanStart) + 1, found: matched })
          await sleep(rlStreak > 3 ? Math.min(rlStreak * 1500, 15000) : 250)
        }

        if (chunkEnd < scanEnd) {
          // More chunks needed — tell client to call again
          send('chunk_done', { 
            nextStart: chunkEnd + 1, 
            scanEnd, 
            matched, 
            orders,
            runId: body.runId || Date.now().toString()
          })
        } else {
          send('done', { matched: orders.length, scanned, runId: body.runId || Date.now().toString() })
        }
      }
    } catch (err: any) {
      send('error', { msg: err.message })
      send('done', { matched: 0, scanned: 0, runId: Date.now().toString() })
    } finally {
      clearInterval(heartbeatInterval)
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
