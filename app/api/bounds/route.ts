import { NextRequest, NextResponse } from 'next/server'
import { fetchOrder } from '@/lib/scraper'

export const runtime = 'nodejs'
export const maxDuration = 60

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export async function POST(req: NextRequest) {
  const { subdomain, slug, anchorId, anchorDate, regressionPoints = [], fromDate, toDate } = await req.json()

  // Build all known reference points
  const pts: Array<{date:string, id:number}> = [
    { date: anchorDate, id: anchorId },
    ...(regressionPoints || [])
  ].filter(p => p.date && p.id > 0)
   .sort((a, b) => a.date.localeCompare(b.date))

  // Walk from the closest known point toward targetDate in steps of 500
  // Returns the last ID whose date is BEFORE target (lo) and first ID AFTER target (hi)
  const findBracket = async (targetDate: string): Promise<{lo: number, hi: number}> => {
    // Find closest known point to targetDate
    let ref = pts[0]
    for (const p of pts) {
      const dThis = Math.abs(new Date(p.date+'T00:00:00').getTime() - new Date(targetDate+'T00:00:00').getTime())
      const dBest = Math.abs(new Date(ref.date+'T00:00:00').getTime() - new Date(targetDate+'T00:00:00').getTime())
      if (dThis < dBest) ref = p
    }

    const forward = targetDate > ref.date
    const STEP = 500
    let lo = ref.id  // last known ID before target
    let hi = ref.id  // first known ID after target

    if (forward) {
      // Walk forward: keep going until we find an ID dated >= targetDate
      for (let i = 1; i <= 400; i++) {
        const pid = ref.id + i * STEP
        const o = await fetchOrder(subdomain, pid)
        if (o && o !== 'rl' && o.slug === slug && o.dateYMD) {
          if (o.dateYMD >= targetDate) {
            hi = o.orderId   // first ID on or after target
            break
          }
          lo = o.orderId     // still before target, keep walking
        }
        await sleep(60)
      }
    } else {
      // Walk backward: keep going until we find an ID dated <= targetDate
      for (let i = 1; i <= 400; i++) {
        const pid = Math.max(1, ref.id - i * STEP)
        const o = await fetchOrder(subdomain, pid)
        if (o && o !== 'rl' && o.slug === slug && o.dateYMD) {
          if (o.dateYMD <= targetDate) {
            lo = o.orderId   // last ID on or before target
            break
          }
          hi = o.orderId     // still after target, keep walking
        }
        await sleep(60)
        if (pid <= 1) break
      }
    }

    return { lo, hi }
  }

  // Find bracket for both dates
  const fromBracket = await findBracket(fromDate)
  const toBracket   = await findBracket(toDate)

  // scanStart = just before fromDate (lo of fromDate bracket, with small buffer)
  // scanEnd   = just after toDate (hi of toDate bracket, with small buffer)
  const scanStart = Math.max(1, fromBracket.lo - 100)
  const scanEnd   = toBracket.hi + 100
  const total     = scanEnd - scanStart + 1

  return NextResponse.json({ scanStart, scanEnd, total,
    debug: { fromBracket, toBracket } })
}
