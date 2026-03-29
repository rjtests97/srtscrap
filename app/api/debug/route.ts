import { NextRequest, NextResponse } from 'next/server'
export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const { subdomain, orderId } = await req.json()
  const id = String(orderId)
  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'Referer': `https://${subdomain}.shiprocket.co/`,
    'X-Requested-With': 'XMLHttpRequest',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  }

  const results: Record<string, any> = {}

  // Show full /pocx response to find the structure
  try {
    const res = await fetch(`https://${subdomain}.shiprocket.co/pocx/tracking/order/${id}`, {
      headers, signal: AbortSignal.timeout(8000)
    })
    const text = await res.text()
    const json = JSON.parse(text)
    results['pocx_full_keys'] = Object.keys(json)
    results['tracking_json_keys'] = json.tracking_json ? Object.keys(json.tracking_json) : 'no tracking_json'
    results['has_order'] = !!json.tracking_json?.order
    results['order_preview'] = json.tracking_json?.order || 'NULL'
    results['search_url'] = json.tracking_json?.search_url || 'not found'
    results['tracking_json_preview'] = JSON.stringify(json.tracking_json).slice(0, 800)
  } catch(e: any) { results['pocx_error'] = e.message }

  // Try the search endpoint that the form submits to
  // Shiprocket tracking search typically POSTs to /pocx/tracking/search with order_id
  const searchBodies = [
    { order_id: id },
    { order_id: id, type: 'order_id' },
    { query: id },
    { search: id, search_type: 'order_id' },
  ]
  for (const body of searchBodies) {
    const key = `search_${JSON.stringify(body)}`
    try {
      const res = await fetch(`https://${subdomain}.shiprocket.co/pocx/tracking/order/${id}/search`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(6000)
      })
      results[key] = { status: res.status, body: (await res.text()).slice(0, 300) }
    } catch(e: any) { results[key] = { error: e.message } }
  }

  // Try GET with order_id as query param
  try {
    const res = await fetch(`https://${subdomain}.shiprocket.co/pocx/tracking/order?order_id=${id}`, {
      headers, signal: AbortSignal.timeout(6000)
    })
    const text = await res.text()
    results['pocx_query_param'] = { status: res.status, body: text.slice(0, 300) }
  } catch(e: any) { results['pocx_query_param'] = { error: e.message } }

  // Try the exact URL the tracking page JS would call
  try {
    const res = await fetch(`https://${subdomain}.shiprocket.co/pocx/tracking/order/${id}?order_id=${id}`, {
      headers, signal: AbortSignal.timeout(6000)
    })
    results['pocx_with_param'] = { status: res.status, body: (await res.text()).slice(0, 300) }
  } catch(e: any) { results['pocx_with_param'] = { error: e.message } }

  return NextResponse.json(results)
}
