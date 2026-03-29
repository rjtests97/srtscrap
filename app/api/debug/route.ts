import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'

// Debug endpoint: shows exactly what each API endpoint returns
// Usage: POST /api/debug with {subdomain, orderId}
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

  const urls = [
    `https://${subdomain}.shiprocket.co/pocx/tracking/order/${id}`,
    `https://${subdomain}.shiprocket.co/api/v1/tracking/order/${id}`,
    `https://${subdomain}.shiprocket.co/api/v1/public/track/order/${id}`,
    `https://${subdomain}.shiprocket.co/tracking/order/${id}`,
  ]

  for (const url of urls) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) })
      const text = await res.text()
      results[url] = {
        status: res.status,
        contentType: res.headers.get('content-type'),
        bodyPreview: text.slice(0, 300),
        isJson: text.trimStart().startsWith('{') || text.trimStart().startsWith('['),
      }
    } catch (e: any) {
      results[url] = { error: e.message }
    }
  }

  return NextResponse.json(results)
}
