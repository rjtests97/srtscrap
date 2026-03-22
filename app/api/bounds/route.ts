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

  // Walk from closest known point in steps of 2000 (not 500)
  // Max 30 steps × 20ms = 600ms per direction = fast
  const walk = async (targetDate: string) => {
    // Find closest known point
    let ref = pts[0]
    for (const p of pts) {
      const d1 = Math.abs(new Date(p.date+'T00:00:00').getTime() - new Date(targetDate+'T00:00:00').getTime())
      const d2 = Math.abs(new Date(ref.date+'T00:00:00').getTime() - new Date(targetDate+'T00:00:00').getTime())
      if (d1 < d2) ref = p
    }

    const forward = targetDate >= ref.date
    let lo = ref.id, hi = ref.id

    // Use large steps — we just need a rough bracket, not exact
    // Step size: 2000 global IDs ≈ ~20 brand IDs at 1% density
    const STEP = 2000
    for (let i = 1; i <= 50; i++) {
      const pid = forward ? ref.id + i * STEP : Math.max(1, ref.id - i * STEP)
      const o = await fetchOrder(subdomain, pid)
      if (o && o !== 'rl' && o.slug === slug && o.dateYMD) {
        if (forward) {
          if (o.dateYMD >= targetDate) { hi = o.orderId; break }
          lo = o.orderId
        } else {
          if (o.dateYMD <= targetDate) { lo = o.orderId; break }
          hi = o.orderId
        }
      }
      // No sleep — go fast
    }

    return { lo, hi }
  }

  try {
    // Run both walks in parallel — cuts time in half
    const [fromB, toB] = await Promise.all([walk(fromDate), walk(toDate)])
    const scanStart = Math.max(1, fromB.lo - 500)
    const scanEnd   = toB.hi + 500
    return NextResponse.json({ scanStart, scanEnd, total: scanEnd - scanStart + 1 })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
