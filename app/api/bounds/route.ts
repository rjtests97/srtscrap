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
      const pts = [{ date: anchorDate, id: anchorId }, ...(regressionPoints||[])]
        .filter((p:any) => p.date && p.id > 0)
        .sort((a:any, b:any) => a.date.localeCompare(b.date))

      const closest = (targetDate: string) => {
        let best = pts[0]
        for (const p of pts) {
          const da = Math.abs(new Date(p.date+'T00:00:00').getTime() - new Date(targetDate+'T00:00:00').getTime())
          const db = Math.abs(new Date(best.date+'T00:00:00').getTime() - new Date(targetDate+'T00:00:00').getTime())
          if (da < db) best = p
        }
        return best
      }

      // Walk from ref toward targetDate, return bracket {lo, hi}
      // lo = last brand ID before targetDate
      // hi = first brand ID on/after targetDate
      const walk = async (targetDate: string) => {
        const ref = closest(targetDate)
        const forward = targetDate > ref.date
        let lo = ref.id, hi = ref.id

        send('log', { msg: `Walking ${forward?'forward':'backward'} from #${ref.id} (${ref.date}) → ${targetDate}`, cls: 'info' })

        for (let i = 1; i <= 300; i++) {
          const pid = forward ? ref.id + i*500 : Math.max(1, ref.id - i*500)
          const o = await fetchOrder(subdomain, pid)
          if (o && o !== 'rl' && o.slug === slug && o.dateYMD) {
            send('log', { msg: `  #${o.orderId} = ${o.orderDate}`, cls: 'info' })
            if (forward) {
              if (o.dateYMD >= targetDate) { hi = o.orderId; break }
              lo = o.orderId
            } else {
              if (o.dateYMD < targetDate) { lo = o.orderId; break }
              hi = o.orderId
            }
          }
          await sleep(50)
          if (!forward && pid <= 1) break
        }
        return { lo, hi }
      }

      const fromB = await walk(fromDate)
      const toB   = await walk(toDate)

      const scanStart = Math.max(1, fromB.lo - 50)
      const scanEnd   = toB.hi + 50
      const total     = scanEnd - scanStart + 1

      send('log', { msg: `Range: #${scanStart}–#${scanEnd} (${total} IDs)`, cls: 'ok' })
      send('result', { scanStart, scanEnd, total })

    } catch (err: any) {
      send('error', { msg: err.message })
      send('result', { scanStart: 0, scanEnd: 0, total: 0 })
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
