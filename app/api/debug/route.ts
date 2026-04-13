import { NextRequest, NextResponse } from 'next/server'
export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const { subdomain, orderId } = await req.json()
  const id = String(orderId || '60476')
  const sub = subdomain || 'minnies'
  const result: Record<string, any> = { timestamp: new Date().toISOString() }

  try {
    const headers = {
      'Accept': 'application/json, text/plain, */*',
      'Referer': `https://${sub}.shiprocket.co/tracking/order/${id}`,
      'Origin': `https://${sub}.shiprocket.co`,
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Cache-Control': 'no-cache',
    }

    const apiRes = await fetch(`https://${sub}.shiprocket.co/pocx/tracking/order/${id}`, {
      headers,
      signal: AbortSignal.timeout(12000),
    })
    const apiText = await apiRes.text()
    result.apiStatus = apiRes.status
    result.apiBodyLength = apiText.length
    result.apiPreview = apiText.slice(0, 600)
    result.apiIsJSON = apiText.trimStart().startsWith('{')
    result.apiIsHTML = apiText.trimStart().startsWith('<')
    if (result.apiIsJSON) {
      try {
        const json = JSON.parse(apiText)
        result.apiHasTrackingJson = !!json.tracking_json
        result.apiHasOrder = !!json.tracking_json?.order
        result.apiSlug = json.tracking_json?.company?.slug || null
        result.apiOrderDate = json.tracking_json?.order?.order_date || null
      } catch {}
    }

    const pageRes = await fetch(`https://${sub}.shiprocket.co/tracking/order/${id}`, {
      headers,
      signal: AbortSignal.timeout(12000),
    })
    const pageText = await pageRes.text()
    result.pageStatus = pageRes.status
    result.pageBodyLength = pageText.length
    result.pageHasApidata = pageText.includes('var apidata =')
    result.pageLooksNotFound = pageText.includes('AWB Not Found')
    const match = pageText.match(/var apidata = (\{[\s\S]*?\});/)
    if (match) {
      try {
        const apidata = JSON.parse(match[1])
        result.pageSlug = apidata.company?.slug || null
        result.pageOrderDate = apidata.order?.order_date || null
        result.pageMaskedOrderId = apidata.order?.order_id || null
        result.pageShipmentStatus = apidata.shipment_status_text || null
      } catch {}
    }
  } catch (e: any) {
    result.error = e.message
    result.errorType = e.name
  }

  return NextResponse.json(result)
}
