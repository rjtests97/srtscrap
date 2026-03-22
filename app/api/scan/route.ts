// POST /api/scan
// Server-side streaming scan — sends results as they're found via SSE
// Runs on Vercel Edge = different IP per region = bypasses rate limits

import { NextRequest } from 'next/server'
import { fetchOrder, predictId, toYMD } from '@/lib/scraper'

export const runtime = 'edge'
export const maxDuration = 300 // 5 min max on Vercel free tier

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function findNearestBrandOrder(subdomain: string, slug: string, id: number, range = 300) {
  for (let d = 0; d <= range; d += 10) {
    const probes = d === 0 ? [id] : [id + d, id - d]
    for (const p of probes) {
      if (p < 1) continue
      const o = await fetchOrder(subdomain, p)
      if (o && o !== 'rl' && o.slug === slug && o.dateYMD) return o
    }
    if (d > 0) await sleep(20)
  }
  return null
}

async function findBoundary(
  subdomain: string, slug: string,
  estimatedId: number,
  targetDate: string, mode: 'first' | 'last',
  send: (msg: string) => void
): Promise<number | null> {
  send(`Finding ${mode} boundary for ${targetDate} (est. #${estimatedId})...`)

  let lo = Math.max(1, estimatedId - 8000)
  let hi = estimatedId + 8000
  let best: number | null = null

  for (let steps = 0; steps < 25; steps++) {
    const mid = Math.floor((lo + hi) / 2)
    const found = await findNearestBrandOrder(subdomain, slug, mid, 300)
    if (!found) {
      if (mode === 'first') lo = mid + 301; else hi = mid - 301
      continue
    }
    send(`  #${found.orderId} = ${found.orderDate}`)
    if (mode === 'first') {
      if (found.dateYMD! >= targetDate) { best = found.orderId; hi = found.orderId - 1 }
      else lo = found.orderId + 1
    } else {
      if (found.dateYMD! <= targetDate) { best = found.orderId; lo = found.orderId + 1 }
      else hi = found.orderId - 1
    }
    await sleep(50)
    if (lo > hi) break
  }

  // Expand if not found
  if (!best) {
    send(`Expanding search window for ${mode}...`)
    lo = Math.max(1, estimatedId - 30000); hi = estimatedId + 30000
    for (let steps = 0; steps < 20; steps++) {
      const mid = Math.floor((lo + hi) / 2)
      const found = await findNearestBrandOrder(subdomain, slug, mid, 500)
      if (!found) { if (mode === 'first') lo = mid + 501; else hi = mid - 501; continue }
      send(`  #${found.orderId} = ${found.orderDate}`)
      if (mode === 'first') {
        if (found.dateYMD! >= targetDate) { best = found.orderId; hi = found.orderId - 1 }
        else lo = found.orderId + 1
      } else {
        if (found.dateYMD! <= targetDate) { best = found.orderId; lo = found.orderId + 1 }
        else hi = found.orderId - 1
      }
      await sleep(50)
      if (lo > hi) break
    }
  }

  send(`→ ${mode} boundary: #${best ?? 'not found'}`)
  return best
}

export async function POST(req: NextRequest) {
  const { brandId, subdomain, slug, anchorId, anchorDate, avgPerDay,
          regressionPoints, fromDate, toDate, concurrency = 5 } = await req.json()

  const encoder = new TextEncoder()
  const stream = new TransformStream()
  const writer = stream.writable.getWriter()

  const send = (type: string, data: any) => {
    const line = `data: ${JSON.stringify({ type, ...data })}\n\n`
    writer.write(encoder.encode(line)).catch(() => {})
  }

  // Run scan async
  ;(async () => {
    try {
      send('log', { msg: `Starting scan: ${fromDate} → ${toDate}`, cls: 'info' })
      send('log', { msg: `Brand: ${slug} | Anchor: #${anchorId} = ${anchorDate}`, cls: 'info' })

      const estFrom = predictId(anchorId, anchorDate, regressionPoints, avgPerDay, fromDate)
      const estTo   = predictId(anchorId, anchorDate, regressionPoints, avgPerDay, toDate)

      send('log', { msg: `Estimated range: #${estFrom}–#${estTo}`, cls: 'info' })

      const logFn = (msg: string) => send('log', { msg, cls: 'info' })

      const scanStart = await findBoundary(subdomain, slug, estFrom, fromDate, 'first', logFn)
      const scanEnd   = await findBoundary(subdomain, slug, estTo,   toDate,   'last',  logFn)

      if (!scanStart || !scanEnd || scanStart > scanEnd) {
        send('error', { msg: 'No orders found for this date range.' })
        send('done', { matched: 0, results: [], runId: Date.now().toString() })
        writer.close()
        return
      }

      const total = scanEnd - scanStart + 1
      send('start', { total, scanStart, scanEnd })
      send('log', { msg: `Scanning #${scanStart}–#${scanEnd} (${total} IDs) at ${concurrency}x`, cls: 'ok' })

      const results: any[] = []
      let scanned = 0, matched = 0
      let rlStreak = 0

      for (let base = scanStart; base <= scanEnd; base += concurrency) {
        const ids: number[] = []
        for (let id = base; id <= Math.min(base + concurrency - 1, scanEnd); id++) ids.push(id)

        const fetched = await Promise.all(ids.map(id => fetchOrder(subdomain, id)))

        for (let i = 0; i < ids.length; i++) {
          const id = ids[i], order = fetched[i]
          scanned++

          if (order === 'rl') {
            rlStreak++
            if (rlStreak > 5) await sleep(Math.min(rlStreak * 2000, 30000))
            continue
          }
          if (rlStreak > 0) rlStreak = Math.max(0, rlStreak - 1)

          if (order && order.slug === slug && order.dateYMD) {
            if (order.dateYMD >= fromDate && order.dateYMD <= toDate) {
              results.push(order); matched++
              send('order', { order })
            }
          }
        }

        send('progress', { done: scanned, total, found: matched })

        // Adaptive delay
        const delay = rlStreak > 0 ? Math.min(rlStreak * 1000, 15000) : 300
        await sleep(delay)
      }

      const dates = results.map(r => r.dateYMD).filter(Boolean).sort()
      const dateLabel = dates.length === 0 ? `${fromDate} to ${toDate}`
                      : dates[0] === dates[dates.length - 1] ? dates[0]
                      : `${dates[0]} to ${dates[dates.length - 1]}`

      send('done', {
        matched, scanned, results, dateLabel,
        runId: Date.now().toString(),
        brandId
      })
    } catch (e: any) {
      send('error', { msg: e.message })
      send('done', { matched: 0, results: [], runId: Date.now().toString() })
    } finally {
      writer.close().catch(() => {})
    }
  })()

  return new Response(stream.readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    }
  })
}
