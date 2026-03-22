import { NextRequest, NextResponse } from 'next/server'
import { fetchOrder } from '@/lib/scraper'

export const runtime = 'nodejs'
export const maxDuration = 60

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export async function POST(req: NextRequest) {
  const { subdomain, slug, anchorId, anchorDate, regressionPoints = [], fromDate, toDate } = await req.json()

  const pts = [{ date: anchorDate, id: anchorId }, ...regressionPoints]
    .filter((p: any) => p.date && p.id > 0)
    .sort((a: any, b: any) => a.date.localeCompare(b.date))

  const walk = async (targetDate: string) => {
    let ref = pts[0]
    for (const p of pts) {
      const d1 = Math.abs(new Date(p.date+'T00:00:00').getTime() - new Date(targetDate+'T00:00:00').getTime())
      const d2 = Math.abs(new Date(ref.date+'T00:00:00').getTime() - new Date(targetDate+'T00:00:00').getTime())
      if (d1 < d2) ref = p
    }
    const forward = targetDate >= ref.date
    let lo = ref.id, hi = ref.id
    for (let i = 1; i <= 300; i++) {
      const pid = forward ? ref.id + i * 500 : Math.max(1, ref.id - i * 500)
      const o = await fetchOrder(subdomain, pid)
      if (o && o !== 'rl' && o.slug === slug && o.dateYMD) {
        if (forward) { if (o.dateYMD >= targetDate) { hi = o.orderId; break }; lo = o.orderId }
        else         { if (o.dateYMD <= targetDate) { lo = o.orderId; break }; hi = o.orderId }
      }
      await sleep(80)
    }
    return { lo, hi }
  }

  const [fromB, toB] = await Promise.all([walk(fromDate), walk(toDate)])
  const scanStart = Math.max(1, fromB.lo - 200)
  const scanEnd   = toB.hi + 200

  return NextResponse.json({ scanStart, scanEnd, total: scanEnd - scanStart + 1 })
}
