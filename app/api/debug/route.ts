import { NextRequest, NextResponse } from 'next/server'
export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const { subdomain, orderId } = await req.json()
  const id = String(orderId || '60476')
  const sub = subdomain || 'minnies'
  const result: Record<string, any> = { timestamp: new Date().toISOString() }

  try {
    const res = await fetch(
      `https://${sub}.shiprocket.co/pocx/tracking/order/${id}`,
      {
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'Referer': `https://${sub}.shiprocket.co/tracking/order/${id}`,
          'Origin': `https://${sub}.shiprocket.co`,
          'X-Requested-With': 'XMLHttpRequest',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Cache-Control': 'no-cache',
        },
        signal: AbortSignal.timeout(12000),
      }
    )
    const text = await res.text()
    result.status = res.status
    result.bodyLength = text.length
    result.bodyPreview = text.slice(0, 600)
    result.isJSON = text.trimStart().startsWith('{')
    result.isHTML = text.trimStart().startsWith('<')
    if (result.isJSON) {
      try {
        const json = JSON.parse(text)
        result.hasTrackingJson = !!json.tracking_json
        result.hasOrder = !!json.tracking_json?.order
        result.slug = json.tracking_json?.company?.slug || null
        result.orderDate = json.tracking_json?.order?.order_date || null
      } catch {}
    }
  } catch (e: any) {
    result.error = e.message
    result.errorType = e.name
  }

  return NextResponse.json(result)
}
