import { NextRequest, NextResponse } from 'next/server'
import { fetchOrder } from '@/lib/scraper'

export const runtime = 'edge'

export async function POST(req: NextRequest) {
  const { subdomain, orderId } = await req.json()
  const result = await fetchOrder(subdomain, parseInt(orderId))
  if (!result || result === 'rl') {
    return NextResponse.json({ ok: false, error: 'Could not fetch order. Check subdomain and order ID.' })
  }
  return NextResponse.json({ ok: true, slug: result.slug, companyName: result.companyName })
}
