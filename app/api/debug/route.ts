import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const { subdomain, orderId } = await req.json()
  const id = String(orderId)
  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'Referer': `https://${subdomain}.shiprocket.co/`,
    'X-Requested-With': 'XMLHttpRequest',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  }

  const results: Record<string, any> = {}

  // Test GET endpoints
  const getUrls = [
    `https://${subdomain}.shiprocket.co/pocx/tracking/order/${id}`,
    `https://${subdomain}.shiprocket.co/api/v1/tracking/order/${id}`,
    `https://${subdomain}.shiprocket.co/api/v1/public/track/order/${id}`,
    `https://${subdomain}.shiprocket.co/api/external/track/order/${id}`,
  ]

  for (const url of getUrls) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) })
      const text = await res.text()
      results[`GET ${url.split(subdomain+'.shiprocket.co')[1]}`] = {
        status: res.status,
        body: text.slice(0, 400),
      }
    } catch (e: any) {
      results[`GET ${url.split(subdomain+'.shiprocket.co')[1]}`] = { error: e.message }
    }
  }

  // Test POST endpoints
  const posts = [
    { url: `/api/v1/external/track`, body: { order_id: id } },
    { url: `/pocx/tracking/search`, body: { order_id: id, type: 'order_id' } },
    { url: `/api/v1/tracking/search`, body: { query: id, type: 'order_id' } },
  ]

  for (const { url, body } of posts) {
    try {
      const res = await fetch(`https://${subdomain}.shiprocket.co${url}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      })
      const text = await res.text()
      results[`POST ${url} ${JSON.stringify(body)}`] = {
        status: res.status,
        body: text.slice(0, 400),
      }
    } catch (e: any) {
      results[`POST ${url}`] = { error: e.message }
    }
  }

  // Test page scrape
  try {
    const res = await fetch(`https://${subdomain}.shiprocket.co/tracking/order/${id}`, {
      headers: { ...headers, Accept: 'text/html' },
      signal: AbortSignal.timeout(10000),
    })
    const text = await res.text()
    const hasNextData = text.includes('__NEXT_DATA__')
    const nextDataMatch = text.match(/__NEXT_DATA__[^>]*>([\s\S]{0,200})/)
    results['PAGE /tracking/order/'+id] = {
      status: res.status,
      hasNextData,
      nextDataPreview: nextDataMatch ? nextDataMatch[1] : 'not found',
    }
  } catch (e: any) {
    results['PAGE scrape'] = { error: e.message }
  }

  return NextResponse.json(results, {
    headers: { 'Cache-Control': 'no-store' }
  })
}
