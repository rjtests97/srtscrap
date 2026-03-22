import { NextRequest } from 'next/server'
import { fetchOrder } from '@/lib/scraper'

export const runtime = 'nodejs'
export const maxDuration = 60

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// How many IDs to scan per server call
// At concurrency=5, ~20 IDs/sec, 50s usable = 1000 IDs max. Use 800 to be safe.
const IDS_PER_CHUNK = 800

export async function POST(req: NextRequest) {
  const body = await req.json()
  const {
    subdomain, slug, concurrency = 5,
    // Date scan params
    fromDate, toDate, scanStart, scanEnd,
    // Manual scan params  
    startId, endId, useAuto = false, stopAfter = 200,
    // Shared
    mode = 'date', runId
  } = body

  const encoder = new TextEncoder()
  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()

  const send = (type: string, data: any) => {
    try {
      writer.write(encoder.encode(`data: ${JSON.stringify({ type, ...data })}\n\n`))
    } catch {}
  }

  // Keepalive ping every 5s so Vercel doesn't close idle connection
  const ping = setInterval(() => {
    try { writer.write(encoder.encode(': ping\n\n')) } catch {}
  }, 5000)

  ;(async () => {
    try {
      if (mode === 'manual') {
        // ── Manual scan ──────────────────────────────────
        const chunkEnd = Math.min(scanStart + IDS_PER_CHUNK - 1, scanEnd)
        send('log', { msg: `Scanning #${scanStart}–#${chunkEnd}`, cls: 'info' })

        const orders: any[] = []
        let scanned = 0, matched = 0, misses = 0, stopped = false

        for (let base = scanStart; base <= chunkEnd && !stopped; base += concurrency) {
          const ids = Array.from({ length: Math.min(concurrency, chunkEnd - base + 1) }, (_, i) => base + i)
          const results = await Promise.all(ids.map(id => fetchOrder(subdomain, id)))

          for (let i = 0; i < ids.length && !stopped; i++) {
            const o = results[i]; scanned++
            if (o && o !== 'rl' && o.slug === slug) {
              orders.push(o); matched++; misses = 0
              send('order', { order: o })
              send('log', { msg: `#${ids[i]}  ${o.orderDate}  ${o.value}  ${o.payment}  ${o.location}`, cls: 'ok' })
            } else if (o !== 'rl') {
              misses++
              if (useAuto && misses >= stopAfter) {
                send('log', { msg: `Auto-stopped: ${stopAfter} consecutive misses`, cls: 'info' })
                stopped = true
              }
            }
          }
          send('progress', { scanned: scanStart + scanned - 1, found: matched })
          await sleep(250)
        }

        if (!stopped && chunkEnd < scanEnd) {
          // More chunks to go
          send('next', { nextStart: chunkEnd + 1, scanEnd, matched, orders })
        } else {
          send('done', { orders })
        }

      } else {
        // ── Date scan ────────────────────────────────────
        const chunkEnd = Math.min(scanStart + IDS_PER_CHUNK - 1, scanEnd)
        send('log', { msg: `Scanning #${scanStart}–#${chunkEnd} of #${scanEnd}`, cls: 'info' })

        const orders: any[] = []
        let scanned = 0, matched = 0, rlStreak = 0

        for (let base = scanStart; base <= chunkEnd; base += concurrency) {
          const ids = Array.from({ length: Math.min(concurrency, chunkEnd - base + 1) }, (_, i) => base + i)
          const results = await Promise.all(ids.map(id => fetchOrder(subdomain, id)))

          for (let i = 0; i < ids.length; i++) {
            const o = results[i]; scanned++
            if (o === 'rl') { rlStreak++; continue }
            rlStreak = Math.max(0, rlStreak - 1)
            if (o && o.slug === slug && o.dateYMD && o.dateYMD >= fromDate && o.dateYMD <= toDate) {
              orders.push(o); matched++
              send('order', { order: o })
              send('log', { msg: `#${ids[i]}  ${o.orderDate}  ${o.value}  ${o.payment}  ${o.location}  ${o.pincode}`, cls: 'ok' })
            }
          }
          send('progress', { scanned: scanStart + scanned - 1, found: matched })
          await sleep(rlStreak > 3 ? Math.min(rlStreak * 1500, 12000) : 250)
        }

        if (chunkEnd < scanEnd) {
          // More chunks to go — tell client to call again with nextStart
          send('next', { nextStart: chunkEnd + 1, scanEnd, matched, orders })
        } else {
          send('done', { orders })
        }
      }

    } catch (err: any) {
      send('error', { msg: err.message })
      send('done', { orders: [] })
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
