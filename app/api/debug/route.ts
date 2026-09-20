import { NextRequest, NextResponse } from 'next/server'
export const runtime = 'nodejs'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

export async function POST(req: NextRequest) {
  const { subdomain, orderId, companyId } = await req.json()
  const id = String(orderId)
  const sub = subdomain || 'minnies'
  const cid = companyId || 4191871

  const lookupUrl = `https://apiv2.shiprocket.co/tracking-form-check?track_id=${id}&track_type=order_id&company_id=${cid}`
  const lookupRes = await fetch(lookupUrl, {
    headers: { 'Accept': 'application/json', 'User-Agent': UA, 'Referer': `https://${sub}.shiprocket.co/`, 'Origin': `https://${sub}.shiprocket.co` },
    signal: AbortSignal.timeout(10000),
  })
  const lookupData = await lookupRes.json()
  const trackingUrl = lookupData?.url
  if (!trackingUrl) return NextResponse.json({ error: 'no tracking url' })

  const awbRes = await fetch(trackingUrl, {
    headers: { 'Accept': 'text/html', 'User-Agent': UA, 'Accept-Language': 'en-IN,en;q=0.9' },
    signal: AbortSignal.timeout(15000),
  })
  const html = await awbRes.text()

  // Find the actual body section with data (skip <style>)
  const bodyIdx = html.indexOf('<body')
  const body = html.slice(bodyIdx)

  // Extract just the tracking-card section which has all the real data
  const cardIdx = body.indexOf('tracking-card')
  const cardSection = cardIdx >= 0 ? body.slice(cardIdx - 20, cardIdx + 3000) : 'NOT FOUND'

  return NextResponse.json({
    status: awbRes.status,
    cardSection,
  })
}
