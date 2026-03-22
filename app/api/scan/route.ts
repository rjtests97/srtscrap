import { NextRequest } from 'next/server'
import { fetchOrder, predictId } from '@/lib/scraper'

export const runtime = 'edge'
export const maxDuration = 300

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// Find nearest brand order within ±range IDs of a given ID
async function findNearestBrandOrder(subdomain: string, slug: string, id: number, range = 150) {
  for (let d = 0; d <= range; d += 5) {
    for (const p of d === 0 ? [id] : [id + d, id - d]) {
      if (p < 1) continue
      const o = await fetchOrder(subdomain, p)
      if (o && o !== 'rl' && o.slug === slug && o.dateYMD) return o
    }
    if (d > 0) await sleep(20)
  }
  return null
}

// Binary search for boundary — finds first/last brand order on targetDate
// Uses the anchor as a reliable starting point, then brackets outward
async function findBoundary(
  subdomain: string, slug: string,
  anchorId: number, anchorDate: string,
  regressionPoints: Array<{date:string,id:number}>,
  avgPerDay: number,
  targetDate: string,
  mode: 'first' | 'last',
  send: (msg: string) => void
): Promise<number | null> {

  // Step 1: Get a tight estimate using only known data points
  // Use regression if available, else anchor + conservative rate
  const pts = [...(regressionPoints || []), {date: anchorDate, id: anchorId}]
    .filter(p => p.date && p.id > 0)
    .sort((a, b) => a.date.localeCompare(b.date))

  const target = new Date(targetDate + 'T00:00:00').getTime()
  let estimatedId: number

  // Find bracketing points from known data
  let before: typeof pts[0] | null = null, after: typeof pts[0] | null = null
  for (const p of pts) {
    const pd = new Date(p.date + 'T00:00:00').getTime()
    if (pd <= target) before = p
    else if (!after) after = p
  }

  if (before && after) {
    // Interpolate between two known points — most accurate
    const span = new Date(after.date + 'T00:00:00').getTime() - new Date(before.date + 'T00:00:00').getTime()
    const pos  = target - new Date(before.date + 'T00:00:00').getTime()
    estimatedId = Math.round(before.id + (pos / span) * (after.id - before.id))
  } else if (before) {
    // Extrapolate forward — use actual measured rate from regression if possible
    let rate = avgPerDay
    if (pts.length >= 2) {
      const p1 = pts[pts.length - 2], p2 = pts[pts.length - 1]
      const days = (new Date(p2.date + 'T00:00:00').getTime() - new Date(p1.date + 'T00:00:00').getTime()) / 86400000
      if (days > 0) rate = (p2.id - p1.id) / days
    }
    const days = (target - new Date(before.date + 'T00:00:00').getTime()) / 86400000
    estimatedId = Math.round(before.id + days * rate)
  } else if (after) {
    let rate = avgPerDay
    if (pts.length >= 2) {
      const p1 = pts[0], p2 = pts[1]
      const days = (new Date(p2.date + 'T00:00:00').getTime() - new Date(p1.date + 'T00:00:00').getTime()) / 86400000
      if (days > 0) rate = (p2.id - p1.id) / days
    }
    const days = (target - new Date(after.date + 'T00:00:00').getTime()) / 86400000
    estimatedId = Math.round(after.id + days * rate)
  } else {
    estimatedId = anchorId
  }

  send(`Finding ${mode} boundary for ${targetDate} (est. #${estimatedId})...`)

  // Step 2: Verify estimate by probing it — adjust if wrong direction
  // First probe the estimate to see what date we're actually at
  const probe = await findNearestBrandOrder(subdomain, slug, estimatedId, 200)
  if (probe) {
    send(`  Probe: #${probe.orderId} = ${probe.orderDate}`)
    // Adjust estimate based on actual probe result
    if (probe.dateYMD! < targetDate) {
      // We're before target — estimate was too low
      // Don't adjust lo/hi yet, binary search will handle it
    }
  }

  // Step 3: Binary search with ±5000 initial window (tight but safe)
  let lo = Math.max(1, estimatedId - 5000)
  let hi = estimatedId + 5000
  let best: number | null = null
  let steps = 0

  while (lo <= hi && steps < 20) {
    steps++
    const mid = Math.floor((lo + hi) / 2)
    const found = await findNearestBrandOrder(subdomain, slug, mid, 150)

    if (!found) {
      if (mode === 'first') lo = mid + 151; else hi = mid - 151
      continue
    }

    if (mode === 'first') {
      if (found.dateYMD! >= targetDate) { best = found.orderId; hi = found.orderId - 1 }
      else lo = found.orderId + 1
    } else {
      if (found.dateYMD! <= targetDate) { best = found.orderId; lo = found.orderId + 1 }
      else hi = found.orderId - 1
    }
    await sleep(30)
    if (lo > hi) break
  }

  // Step 4: Expand window if not found (estimate was off)
  if (!best) {
    send(`  Estimate was off, expanding search...`)
    lo = Math.max(1, estimatedId - 25000); hi = estimatedId + 25000
    steps = 0
    while (lo <= hi && steps < 15) {
      steps++
      const mid = Math.floor((lo + hi) / 2)
      const found = await findNearestBrandOrder(subdomain, slug, mid, 300)
      if (!found) { if (mode === 'first') lo = mid + 301; else hi = mid - 301; continue }
      if (mode === 'first') {
        if (found.dateYMD! >= targetDate) { best = found.orderId; hi = found.orderId - 1 }
        else lo = found.orderId + 1
      } else {
        if (found.dateYMD! <= targetDate) { best = found.orderId; lo = found.orderId + 1 }
        else hi = found.orderId - 1
      }
      await sleep(30)
      if (lo > hi) break
    }
  }

  send(`→ ${mode} boundary: #${best ?? 'not found'}`)
  return best
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { subdomain, slug, anchorId, anchorDate, avgPerDay, regressionPoints,
          concurrency = 5, mode = 'date' } = body

  const encoder = new TextEncoder()
  const stream  = new TransformStream()
  const writer  = stream.writable.getWriter()

  let logBuffer: string[] = []
  let lastFlush = Date.now()

  const send = (type: string, data: any) => {
    const line = `data: ${JSON.stringify({ type, ...data })}\n\n`
    writer.write(encoder.encode(line)).catch(() => {})
  }

  // Batched log sender — prevents SSE buffer overflow on long scans
  const sendLog = (msg: string, cls: string = '') => {
    // Always send important messages immediately
    if (cls === 'ok' || cls === 'err' || msg.startsWith('→') || msg.startsWith('Finding') || msg.startsWith('Scan')) {
      send('log', { msg, cls })
      return
    }
    // Buffer routine logs, flush every 2s or every 20 messages
    logBuffer.push(JSON.stringify({ msg, cls }))
    const now = Date.now()
    if (logBuffer.length >= 20 || now - lastFlush > 2000) {
      logBuffer.forEach(l => send('log', JSON.parse(l)))
      logBuffer = []
      lastFlush = now
    }
  }

  ;(async () => {
    try {
      const orders: any[] = []
      let scanned = 0

      if (mode === 'manual') {
        // ── Manual scan ──────────────────────────────
        const { startId, endId, useAuto = false, stopAfter = 100 } = body
        const maxId = useAuto ? startId + 50000 : endId
        send('log', { msg: `Manual: #${startId} → ${useAuto ? 'auto-stop' : '#' + endId} | ${concurrency}x`, cls: 'info' })
        send('start', { total: useAuto ? 0 : maxId - startId + 1 })

        let misses = 0, matched = 0, stopped = false

        for (let base = startId; base <= maxId && !stopped; base += concurrency) {
          const ids: number[] = []
          for (let id = base; id <= Math.min(base + concurrency - 1, maxId); id++) ids.push(id)

          const fetched = await Promise.all(ids.map(id => fetchOrder(subdomain, id)))

          for (let i = 0; i < ids.length && !stopped; i++) {
            const o = fetched[i]
            scanned++
            if (o && o !== 'rl' && o.slug === slug) {
              orders.push(o); matched++; misses = 0
              send('order', { order: o })
              sendLog(`#${ids[i]}  ${o.orderDate}  ${o.value}  ${o.payment}  ${o.location}`, 'ok')
            } else if (o !== 'rl') {
              misses++
            }
            // Auto-stop: only trigger ONCE when threshold is hit
            if (useAuto && misses >= stopAfter) {
              send('log', { msg: `Auto-stopped after ${stopAfter} consecutive misses`, cls: 'info' })
              stopped = true
              break
            }
          }

          send('progress', { done: scanned, total: useAuto ? 0 : maxId - startId + 1, found: matched })
          await sleep(300)
        }

        // Flush remaining logs
        logBuffer.forEach(l => send('log', JSON.parse(l))); logBuffer = []
        send('done', { matched: orders.length, scanned, results: orders, runId: Date.now().toString() })

      } else {
        // ── Date scan ────────────────────────────────
        const { fromDate, toDate } = body
        send('log', { msg: `Scan: ${fromDate} → ${toDate}`, cls: 'info' })
        send('log', { msg: `Anchor: #${anchorId} = ${anchorDate} | ${regressionPoints?.length || 0} cal pts`, cls: 'info' })

        const logFn = (msg: string) => send('log', { msg, cls: 'info' })

        const scanStart = await findBoundary(subdomain, slug, anchorId, anchorDate, regressionPoints || [], avgPerDay, fromDate, 'first', logFn)
        const scanEnd   = await findBoundary(subdomain, slug, anchorId, anchorDate, regressionPoints || [], avgPerDay, toDate,   'last',  logFn)

        if (!scanStart || !scanEnd || scanStart > scanEnd) {
          send('log', { msg: '⚠ No orders found for this range. Try a smaller range first.', cls: 'err' })
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
            const o = fetched[i]
            scanned++
            if (o === 'rl') { rlStreak++; continue }
            rlStreak = Math.max(0, rlStreak - 1)
            if (o && o.slug === slug && o.dateYMD && o.dateYMD >= fromDate && o.dateYMD <= toDate) {
              orders.push(o); matched++
              send('order', { order: o })
              sendLog(`#${ids[i]}  ${o.orderDate}  ${o.value}  ${o.payment}  ${o.location}  ${o.pincode}`, 'ok')
            }
          }

          send('progress', { done: scanned, total, found: matched })

          // Flush buffered logs periodically
          if (logBuffer.length > 0) {
            logBuffer.forEach(l => send('log', JSON.parse(l))); logBuffer = []
            lastFlush = Date.now()
          }

          await sleep(rlStreak > 3 ? Math.min(rlStreak * 1500, 20000) : 300)
        }

        logBuffer.forEach(l => send('log', JSON.parse(l))); logBuffer = []
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
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    }
  })
}
