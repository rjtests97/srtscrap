import { NextRequest, NextResponse } from 'next/server'
export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const { subdomain, orderId } = await req.json()
  const id = String(orderId || '61712')
  const sub = subdomain || 'minnies'

  const res = await fetch(`https://${sub}.shiprocket.co/tracking/order/${id}`, {
    headers: {
      'Accept': 'text/html',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    },
    signal: AbortSignal.timeout(15000),
  })
  const html = await res.text()
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/)
  if (!m) return NextResponse.json({ error: 'no __NEXT_DATA__' })

  const nd = JSON.parse(m[1])
  const pp = nd?.props?.pageProps
  const td = pp?.trackingData?.tracking_json || pp?.tracking_json

  // Search entire JSON for payment and total values
  const fullStr = JSON.stringify(td || pp)
  const paymentMatches = [...fullStr.matchAll(/"[^"]*[Pp]ayment[^"]*"\s*:\s*("[^"]*"|[0-9]+)/g)].map(m=>m[0]).slice(0,20)
  const totalMatches   = [...fullStr.matchAll(/"[^"]*[Tt]otal[^"]*"\s*:\s*("[^"]*"|[0-9.]+)/g)].map(m=>m[0]).slice(0,20)
  const amountMatches  = [...fullStr.matchAll(/"[^"]*[Aa]mount[^"]*"\s*:\s*("[^"]*"|[0-9.]+)/g)].map(m=>m[0]).slice(0,20)

  return NextResponse.json({
    order: td?.order,
    order_keys: td?.order ? Object.keys(td.order) : null,
    payment_fields: paymentMatches,
    total_fields: totalMatches,
    amount_fields: amountMatches,
    // also dump first 2000 chars of the tracking_json to see structure
    td_preview: fullStr.slice(0, 3000),
  })
}
