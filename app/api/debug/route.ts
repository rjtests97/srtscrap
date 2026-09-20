import { NextRequest, NextResponse } from 'next/server'
export const runtime = 'nodejs'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

export async function POST(req: NextRequest) {
  const { subdomain, orderId, companyId } = await req.json()
  const id = String(orderId)
  const sub = subdomain || 'minnies'
  const cid = companyId || 4191871

  // Step 1: get the tracking URL
  const lookupUrl = `https://apiv2.shiprocket.co/tracking-form-check?track_id=${id}&track_type=order_id&company_id=${cid}`
  const lookupRes = await fetch(lookupUrl, {
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'User-Agent': UA,
      'Referer': `https://${sub}.shiprocket.co/`,
      'Origin': `https://${sub}.shiprocket.co`,
    },
    signal: AbortSignal.timeout(10000),
  })
  const lookupData = await lookupRes.json()
  const trackingUrl = lookupData?.url

  if (!trackingUrl) {
    return NextResponse.json({ step1_lookup: { status: lookupRes.status, data: lookupData }, step2_fetch: null })
  }

  // Step 2: fetch that tracking URL
  const awbRes = await fetch(trackingUrl, {
    headers: {
      'Accept': 'text/html,application/xhtml+xml',
      'User-Agent': UA,
      'Accept-Language': 'en-IN,en;q=0.9',
    },
    signal: AbortSignal.timeout(15000),
  })
  const awbHtml = await awbRes.text()

  return NextResponse.json({
    step1_lookup: { status: lookupRes.status, url: trackingUrl },
    step2_fetch: {
      status: awbRes.status,
      length: awbHtml.length,
      hasApidata: awbHtml.includes('var apidata = '),
      preview: awbHtml.slice(0, 300),
    },
  })
}
