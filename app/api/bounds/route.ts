import { NextRequest } from 'next/server'
import { fetchOrder } from '@/lib/scraper'

export const runtime = 'nodejs'
export const maxDuration = 60

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export async function POST(req: NextRequest) {
  const { subdomain, slug, anchorId, anchorDate, regressionPoints = [], fromDate, toDate } = await req.json()

  const encoder = new TextEncoder()
  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()
  const send = (type: string, data: any) => {
    try { writer.write(encoder.encode(`data: ${JSON.stringify({ type, ...data })}\n\n`)) } catch {}
  }
  const ping = setInterval(() => {
    try { writer.write(encoder.encode(': ping\n\n')) } catch {}
  }, 4000)

  ;(async () => {
    try {
      // All known reference points sorted by date
      const pts = [{ date: anchorDate, id: anchorId }, ...(regressionPoints || [])]
        .filter((p: any) => p.date && p.id > 0)
        .sort((a: any, b: any) => a.date.localeCompare(b.date))

      // Single forward walk from anchor — finds BOTH boundaries in one pass
      // As we walk forward, we note when we cross fromDate and toDate
      send('log', { msg: `Walking from #${anchorId} (${anchorDate})...`, cls: 'info' })

      // Find best starting point (closest known to fromDate)
      let best = pts[0]
      for (const p of pts) {
        const da = Math.abs(new Date(p.date+'T00:00:00').getTime() - new Date(fromDate+'T00:00:00').getTime())
        const db = Math.abs(new Date(best.date+'T00:00:00').getTime() - new Date(fromDate+'T00:00:00').getTime())
        if (da < db) best = p
      }

      const forward = fromDate >= best.date
      let fromLo = best.id, fromHi = best.id
      let toLo   = best.id, toHi   = best.id
      let foundFrom = false, foundTo = false

      for (let i = 1; i <= 300 && !(foundFrom && foundTo); i++) {
        const pid = forward ? best.id + i * 500 : Math.max(1, best.id - i * 500)
        const o = await fetchOrder(subdomain, pid)

        if (o && o !== 'rl' && o.slug === slug && o.dateYMD) {
          send('log', { msg: `  #${o.orderId} = ${o.orderDate}`, cls: 'info' })

          if (forward) {
            // Looking for fromDate bracket
            if (!foundFrom) {
              if (o.dateYMD >= fromDate) { fromHi = o.orderId; foundFrom = true }
              else fromLo = o.orderId
            }
            // Looking for toDate bracket (always after fromDate)
            if (!foundTo) {
              if (o.dateYMD > toDate) { toHi = o.orderId; foundTo = true }
              else toLo = o.orderId
            }
          } else {
            if (!foundFrom) {
              if (o.dateYMD < fromDate) { fromLo = o.orderId; foundFrom = true }
              else fromHi = o.orderId
            }
            if (!foundTo) {
              if (o.dateYMD < fromDate) { toLo = o.orderId; foundTo = true }
              else toHi = o.orderId
            }
          }
        }
        await sleep(50)
        if (!forward && pid <= 1) break
      }

      const scanStart = Math.max(1, fromLo - 50)
      const scanEnd   = toHi + 50
      const total     = scanEnd - scanStart + 1

      send('log', { msg: `✓ #${scanStart}–#${scanEnd} (${total} IDs)`, cls: 'ok' })
      send('result', { scanStart, scanEnd, total })

    } catch (err: any) {
      send('error', { msg: String(err.message || err) })
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
