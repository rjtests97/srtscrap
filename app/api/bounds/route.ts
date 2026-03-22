import { NextRequest, NextResponse } from 'next/server'
import { fetchOrder } from '@/lib/scraper'

export const runtime = 'nodejs'
export const maxDuration = 60

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// Walk from a known (id, date) point toward a targetDate in steps of 500
// Returns: lo = last brand ID whose date < targetDate
//          hi = first brand ID whose date >= targetDate
async function walkTo(
  subdomain: string, slug: string,
  refId: number, refDate: string,
  targetDate: string
): Promise<{ lo: number; hi: number }> {
  const forward = targetDate > refDate
  let lo = refId
  let hi = refId

  for (let i = 1; i <= 400; i++) {
    const pid = forward
      ? refId + i * 500
      : Math.max(1, refId - i * 500)

    const o = await fetchOrder(subdomain, pid)

    if (o && o !== 'rl' && o.slug === slug && o.dateYMD) {
      if (forward) {
        if (o.dateYMD >= targetDate) { hi = o.orderId; break }
        lo = o.orderId  // still before target, keep walking
      } else {
        if (o.dateYMD < targetDate) { lo = o.orderId; break }
        hi = o.orderId  // still on/after target, keep walking
      }
    }
    await sleep(60)
    if (!forward && pid <= 1) break
  }

  return { lo, hi }
}

export async function POST(req: NextRequest) {
  const { subdomain, slug, anchorId, anchorDate, regressionPoints = [], fromDate, toDate } = await req.json()

  // Use all known calibration points to find the closest starting reference
  const pts: Array<{ date: string; id: number }> = [
    { date: anchorDate, id: anchorId },
    ...(regressionPoints || [])
  ].filter(p => p.date && p.id > 0).sort((a, b) => a.date.localeCompare(b.date))

  const closest = (targetDate: string) => {
    let best = pts[0]
    for (const p of pts) {
      const da = Math.abs(new Date(p.date + 'T00:00:00').getTime() - new Date(targetDate + 'T00:00:00').getTime())
      const db = Math.abs(new Date(best.date + 'T00:00:00').getTime() - new Date(targetDate + 'T00:00:00').getTime())
      if (da < db) best = p
    }
    return best
  }

  // Find start boundary: walk toward fromDate, take lo (last ID before fromDate)
  const refFrom = closest(fromDate)
  const fromWalk = await walkTo(subdomain, slug, refFrom.id, refFrom.date, fromDate)

  // Find end boundary: walk toward toDate, take hi (first ID after toDate)
  const refTo = closest(toDate)
  const toWalk = await walkTo(subdomain, slug, refTo.id, refTo.date, toDate)

  // scanStart = lo of fromDate walk (last ID before fromDate, minus small buffer)
  // scanEnd   = hi of toDate walk (first ID after toDate, plus small buffer)
  const scanStart = Math.max(1, fromWalk.lo - 50)
  const scanEnd   = toWalk.hi + 50
  const total     = scanEnd - scanStart + 1

  return NextResponse.json({ scanStart, scanEnd, total })
}
