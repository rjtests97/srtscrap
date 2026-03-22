import { NextRequest, NextResponse } from 'next/server'
import { fetchOrder } from '@/lib/scraper'

export const runtime = 'edge'

export async function POST(req: NextRequest) {
  const { subdomain, anchorId, slug } = await req.json()
  try {
    const probes = await Promise.all(
      Array.from({ length: 30 }, (_, i) => fetchOrder(subdomain, anchorId + i + 1))
    )
    const found = probes.filter(o => o && o !== 'rl' && (o as any).slug === slug) as any[]
    if (!found.length) return NextResponse.json({ avgPerDay: 30 })
    const densityEst = Math.round((found.length / 30) * 2000)
    const dates = [...new Set(found.map(o => o.dateYMD).filter(Boolean))].sort()
    let dateEst = densityEst
    if (dates.length >= 2) {
      const daySpan = (new Date(dates[dates.length-1] + ' 00:00:00').getTime() - new Date(dates[0] + ' 00:00:00').getTime()) / 86400000
      if (daySpan > 0) dateEst = Math.round(found.length / daySpan)
    }
    const avgPerDay = Math.min(500, Math.max(5, Math.round((densityEst + dateEst) / 2)))
    return NextResponse.json({ avgPerDay })
  } catch {
    return NextResponse.json({ avgPerDay: 30 })
  }
}
