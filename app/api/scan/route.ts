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

// Find boundary using walk + binary search
// Walk from anchor in steps to bracket the date, then binary search
// Never uses avgPerDay — measures actual rate from API responses
async function findBoundary(
  subdomain: string, slug: string,
  anchorId: number, anchorDate: string,
  regressionPoints: Array<{date:string,id:number}>,
  _avgPerDay: number, // ignored — we measure real rate
  targetDate: string,
  mode: 'first' | 'last',
  send: (msg: string) => void
): Promise<number | null> {

  send(`Finding ${mode} boundary for ${targetDate}...`)

  // Build list of all known (date, id) points including anchor + regression
  const knownPts = [
    { date: anchorDate, id: anchorId },
    ...(regressionPoints || [])
  ].filter(p => p.date && p.id > 0)
   .sort((a, b) => a.date.localeCompare(b.date))

  // Find the closest known point to targetDate
  const target = targetDate
  let bestKnown = knownPts[0]
  for (const p of knownPts) {
    const dBest = Math.abs(new Date(bestKnown.date+'T00:00:00').getTime() - new Date(target+'T00:00:00').getTime())
    const dThis = Math.abs(new Date(p.date+'T00:00:00').getTime() - new Date(target+'T00:00:00').getTime())
    if (dThis < dBest) bestKnown = p
  }

  send(`  Starting from known point: #${bestKnown.id} = ${bestKnown.date}`)

  // Walk from bestKnown toward target in steps of 1000
  // Measure actual ID progression rate from responses
  const STEP = 1000
  let lo: number, hi: number
  let lastKnownId = bestKnown.id
  let lastKnownDate = bestKnown.date

  if (target > lastKnownDate) {
    // Target is after known point — walk forward
    lo = lastKnownId
    hi = lastKnownId
    for (let i = 1; i <= 200; i++) {
      const probeId = lastKnownId + i * STEP
      const o = await findNearestBrandOrder(subdomain, slug, probeId, 100)
      if (!o) continue
      send(`  Walk: #${o.orderId} = ${o.orderDate}`)
      if (o.dateYMD! >= target) {
        hi = o.orderId
        break
      }
      lo = o.orderId
      await sleep(30)
    }
    if (hi === lastKnownId) hi = lastKnownId + 200 * STEP
  } else {
    // Target is before known point — walk backward
    hi = lastKnownId
    lo = Math.max(1, lastKnownId)
    for (let i = 1; i <= 200; i++) {
      const probeId = Math.max(1, lastKnownId - i * STEP)
      const o = await findNearestBrandOrder(subdomain, slug, probeId, 100)
      if (!o) continue
      send(`  Walk: #${o.orderId} = ${o.orderDate}`)
      if (o.dateYMD! <= target) {
        lo = o.orderId
        break
      }
      hi = o.orderId
      if (probeId <= 1) break
      await sleep(30)
    }
  }

  send(`  Bracket: #${lo}–#${hi} | Binary searching...`)

  // Binary search within bracket
  let best: number | null = null
  let blo = lo, bhi = hi

  for (let steps = 0; steps < 25 && blo <= bhi; steps++) {
    const mid = Math.floor((blo + bhi) / 2)
    const found = await findNearestBrandOrder(subdomain, slug, mid, 150)
    if (!found) {
      if (mode === 'first') blo = mid + 151; else bhi = mid - 151
      continue
    }
    if (mode === 'first') {
      if (found.dateYMD! >= target) { best = found.orderId; bhi = found.orderId - 1 }
      else blo = found.orderId + 1
    } else {
      if (found.dateYMD! <= target) { best = found.orderId; blo = found.orderId + 1 }
      else bhi = found.orderId - 1
    }
    await sleep(30)
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
