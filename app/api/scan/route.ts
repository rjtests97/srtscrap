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
    const line = `data: ${JSON.stringify({ type, ...data })}\n\n`
    writer.write(encoder.encode(line)).catch(() => {})
  }

  ;(async () => {
    try {
      const orders: any[] = []
      let scanned = 0

      if (mode === 'manual') {
        // ── Manual: just scan startId → endId directly ──
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
            } else if (o !== 'rl') {
              misses++
            }
            if (useAuto && misses >= stopAfter) {
              send('log', { msg: `Auto-stopped: ${stopAfter} consecutive misses`, cls: 'info' })
              stopped = true
            }
          }
          send('progress', { done: scanned, total: useAuto ? 0 : maxId - startId + 1, found: matched })
          await sleep(300)
        }
        send('done', { matched: orders.length, scanned, runId: Date.now().toString() })

      } else {
        // ── Date scan: walk from anchor to find boundaries fast ──
        const { fromDate, toDate, anchorId, anchorDate, regressionPoints = [] } = body

        send('log', { msg: `Scan: ${fromDate} → ${toDate}`, cls: 'info' })
        send('log', { msg: `Anchor: #${anchorId} = ${anchorDate}`, cls: 'info' })

        // Use all known points (anchor + regression) to find best starting point
        const pts = [{ date: anchorDate, id: anchorId }, ...regressionPoints]
          .filter((p: any) => p.date && p.id > 0)
          .sort((a: any, b: any) => a.date.localeCompare(b.date))

        // Find bracket for fromDate by walking from closest known point
        const findBracket = async (targetDate: string) => {
          // Find closest known point
          let ref = pts[0]
          for (const p of pts) {
            if (Math.abs(new Date(p.date+'T00:00:00').getTime() - new Date(targetDate+'T00:00:00').getTime()) <
                Math.abs(new Date(ref.date+'T00:00:00').getTime() - new Date(targetDate+'T00:00:00').getTime())) {
              ref = p
            }
          }

          send('log', { msg: `Walking from #${ref.id} (${ref.date}) → ${targetDate}...`, cls: 'info' })

          const forward = targetDate > ref.date
          const STEP = 500
          let lo = ref.id, hi = ref.id

          // Walk in steps of 500 until we bracket the target
          for (let i = 1; i <= 300; i++) {
            const probeId = forward ? ref.id + i * STEP : Math.max(1, ref.id - i * STEP)
            // Fetch single order — no expensive nearest-search here
            const o = await fetchOrder(subdomain, probeId)
            if (o && o !== 'rl' && o.slug === slug && o.dateYMD) {
              send('log', { msg: `  #${o.orderId} = ${o.orderDate}`, cls: 'info' })
              if (forward) {
                if (o.dateYMD >= targetDate) { hi = o.orderId; break }
                lo = o.orderId
              } else {
                if (o.dateYMD <= targetDate) { lo = o.orderId; break }
                hi = o.orderId
              }
            }
            await sleep(100)
          }

          return { lo, hi }
        }

        const fromBracket = await findBracket(fromDate)
        const toBracket   = await findBracket(toDate)

        // scanStart = lo of fromDate bracket (with buffer)
        // scanEnd   = hi of toDate bracket (with buffer)
        const scanStart = Math.max(1, fromBracket.lo - 200)
        const scanEnd   = toBracket.hi + 200
        const total     = scanEnd - scanStart + 1

        send('log', { msg: `Range: #${scanStart}–#${scanEnd} (${total} IDs)`, cls: 'ok' })
        send('start', { total, scanStart, scanEnd })

        let matched = 0, rlStreak = 0

        for (let base = scanStart; base <= scanEnd; base += concurrency) {
          const ids: number[] = []
          for (let id = base; id <= Math.min(base + concurrency - 1, scanEnd); id++) ids.push(id)
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

          send('progress', { done: scanned, total, found: matched })
          await sleep(rlStreak > 3 ? Math.min(rlStreak * 1500, 15000) : 300)
        }

        send('done', { matched: orders.length, scanned, runId: Date.now().toString() })
      }

    } catch (err: any) {
      send('error', { msg: err.message })
      send('done', { matched: 0, scanned: 0, runId: Date.now().toString() })
    } finally {
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
