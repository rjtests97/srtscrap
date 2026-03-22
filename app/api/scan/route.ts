import { NextRequest } from 'next/server'
import { fetchOrder, predictId } from '@/lib/scraper'

export const runtime = 'edge'
export const maxDuration = 300

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function findNearestBrandOrder(subdomain: string, slug: string, id: number, range = 200) {
  for (let d = 0; d <= range; d += 10) {
    for (const p of d === 0 ? [id] : [id + d, id - d]) {
      if (p < 1) continue
      const o = await fetchOrder(subdomain, p)
      if (o && o !== 'rl' && o.slug === slug && o.dateYMD) return o
    }
    if (d > 0) await sleep(15)
  }
  return null
}

async function findBoundary(
  subdomain: string, slug: string,
  estimatedId: number, targetDate: string,
  mode: 'first' | 'last',
  send: (msg: string) => void
): Promise<number | null> {
  send(`Finding ${mode} boundary for ${targetDate} (est. #${estimatedId})...`)
  let lo = Math.max(1, estimatedId - 10000), hi = estimatedId + 10000
  let best: number | null = null

  for (let steps = 0; steps < 20; steps++) {
    const mid = Math.floor((lo + hi) / 2)
    const found = await findNearestBrandOrder(subdomain, slug, mid, 250)
    if (!found) { if (mode === 'first') lo = mid + 251; else hi = mid - 251; continue }
    send(`  #${found.orderId} = ${found.orderDate}`)
    if (mode === 'first') {
      if (found.dateYMD! >= targetDate) { best = found.orderId; hi = found.orderId - 1 }
      else lo = found.orderId + 1
    } else {
      if (found.dateYMD! <= targetDate) { best = found.orderId; lo = found.orderId + 1 }
      else hi = found.orderId - 1
    }
    await sleep(40)
    if (lo > hi) break
  }

  // Expand and retry once if not found
  if (!best) {
    send(`  Expanding search window...`)
    lo = Math.max(1, estimatedId - 40000); hi = estimatedId + 40000
    for (let steps = 0; steps < 15; steps++) {
      const mid = Math.floor((lo + hi) / 2)
      const found = await findNearestBrandOrder(subdomain, slug, mid, 400)
      if (!found) { if (mode === 'first') lo = mid + 401; else hi = mid - 401; continue }
      send(`  #${found.orderId} = ${found.orderDate}`)
      if (mode === 'first') {
        if (found.dateYMD! >= targetDate) { best = found.orderId; hi = found.orderId - 1 }
        else lo = found.orderId + 1
      } else {
        if (found.dateYMD! <= targetDate) { best = found.orderId; lo = found.orderId + 1 }
        else hi = found.orderId - 1
      }
      await sleep(40)
      if (lo > hi) break
    }
  }
  send(`→ ${mode} boundary: #${best ?? 'not found'}`)
  return best
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { subdomain, slug, anchorId, anchorDate, avgPerDay, regressionPoints, concurrency = 5, mode = 'date' } = body

  const encoder = new TextEncoder()
  const stream = new TransformStream()
  const writer = stream.writable.getWriter()
  const send = (type: string, data: any) => {
    writer.write(encoder.encode(`data: ${JSON.stringify({ type, ...data })}\n\n`)).catch(() => {})
  }

  ;(async () => {
    try {
      const orders: any[] = []
      let scanned = 0

      if (mode === 'manual') {
        // ── Manual scan ──────────────────────────────
        const { startId, endId, useAuto = false, stopAfter = 100 } = body
        const maxId = useAuto ? startId + 15000 : endId
        send('log', { msg: `Manual scan: #${startId}${useAuto ? '+' : ' → #' + endId} | ${concurrency}x`, cls: 'info' })
        send('start', { total: useAuto ? 0 : maxId - startId + 1 })
        let misses = 0, matched = 0

        for (let base = startId; base <= maxId; base += concurrency) {
          const ids: number[] = []
          for (let id = base; id <= Math.min(base + concurrency - 1, maxId); id++) ids.push(id)
          const fetched = await Promise.all(ids.map(id => fetchOrder(subdomain, id)))
          for (let i = 0; i < ids.length; i++) {
            const o = fetched[i]; scanned++
            if (o && o !== 'rl' && o.slug === slug) {
              orders.push(o); matched++; misses = 0
              send('order', { order: o })
              send('log', { msg: `#${ids[i]}  ${o.orderDate}  ${o.value}  ${o.payment}  ${o.location}`, cls: 'ok' })
            } else if (o !== 'rl') {
              misses++
            }
            if (useAuto && misses >= stopAfter) { send('log', { msg: `Auto-stopped: ${stopAfter} consecutive misses`, cls: 'info' }); break }
          }
          send('progress', { done: scanned, total: useAuto ? 0 : maxId - startId + 1, found: matched })
          await sleep(300)
        }
        send('done', { matched: orders.length, scanned, results: orders, runId: Date.now().toString() })

      } else {
        // ── Date scan ────────────────────────────────
        const { fromDate, toDate } = body
        send('log', { msg: `Scan: ${fromDate} → ${toDate} | anchor #${anchorId} = ${anchorDate}`, cls: 'info' })

        const estFrom = predictId(anchorId, anchorDate, regressionPoints || [], avgPerDay, fromDate)
        const estTo   = predictId(anchorId, anchorDate, regressionPoints || [], avgPerDay, toDate)
        send('log', { msg: `Estimated: #${estFrom} → #${estTo}`, cls: 'info' })

        const logFn = (msg: string) => send('log', { msg, cls: 'info' })
        const scanStart = await findBoundary(subdomain, slug, estFrom, fromDate, 'first', logFn)
        const scanEnd   = await findBoundary(subdomain, slug, estTo,   toDate,   'last',  logFn)

        if (!scanStart || !scanEnd || scanStart > scanEnd) {
          send('error', { msg: 'No orders found for this date range. Check anchor date or try a wider range.' })
          send('done', { matched: 0, scanned: 0, results: [], runId: Date.now().toString() })
          return
        }

        const total = scanEnd - scanStart + 1
        send('start', { total, scanStart, scanEnd })
        send('log', { msg: `Scanning #${scanStart}–#${scanEnd} (${total} IDs) at ${concurrency}x`, cls: 'ok' })

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
          await sleep(rlStreak > 3 ? Math.min(rlStreak * 1500, 20000) : 300)
        }
        send('done', { matched: orders.length, scanned, results: orders, runId: Date.now().toString() })
      }
    } catch (err: any) {
      send('error', { msg: err.message })
      send('done', { matched: 0, scanned: 0, results: [], runId: Date.now().toString() })
    } finally {
      writer.close().catch(() => {})
    }
  })()

  return new Response(stream.readable, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' }
  })
}
