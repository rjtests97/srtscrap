import { NextRequest, NextResponse } from 'next/server'
export const runtime = 'nodejs'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

export async function POST(req: NextRequest) {
  const { subdomain, orderId, companyId } = await req.json()
  const id = String(orderId)
  const sub = subdomain || 'minnies'
  const cid = companyId || 4191871

  // Test the tracking-form-check API WITH proper Referer/Origin headers
  const lookupUrl = `https://apiv2.shiprocket.co/tracking-form-check?track_id=${id}&track_type=order_id&company_id=${cid}`

  const withHeaders = await fetch(lookupUrl, {
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'User-Agent': UA,
      'Referer': `https://${sub}.shiprocket.co/`,
      'Origin': `https://${sub}.shiprocket.co`,
    },
    signal: AbortSignal.timeout(10000),
  })
  const withHeadersData = await withHeaders.text()

  const withoutHeaders = await fetch(lookupUrl, { signal: AbortSignal.timeout(10000) })
  const withoutHeadersData = await withoutHeaders.text()

  return NextResponse.json({
    withReferer: { status: withHeaders.status, body: withHeadersData },
    withoutReferer: { status: withoutHeaders.status, body: withoutHeadersData },
  })
}
