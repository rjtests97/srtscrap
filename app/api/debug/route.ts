import { NextRequest, NextResponse } from 'next/server'
export const runtime = 'nodejs'

function extractApidata(html: string): any {
  const idx = html.indexOf('var apidata = ')
  if (idx < 0) return null
  // Find the JSON object - count braces
  const start = html.indexOf('{', idx)
  if (start < 0) return null
  let depth = 0, i = start
  while (i < html.length) {
    if (html[i] === '{') depth++
    else if (html[i] === '}') { depth--; if (depth === 0) break }
    i++
  }
  try { return JSON.parse(html.slice(start, i + 1)) } catch { return null }
}

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
  const apidata = extractApidata(html)

  return NextResponse.json({
    apidata_keys: apidata ? Object.keys(apidata) : null,
    show_pii: apidata?.show_pii,
    order: apidata?.order,
    order_keys: apidata?.order ? Object.keys(apidata.order) : null,
    order_total: apidata?.order?.order_total,
    payment_method: apidata?.order?.payment_method,
    // Also check if these fields exist but are empty
    order_full: apidata?.order,
  })
}
