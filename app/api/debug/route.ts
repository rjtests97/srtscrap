import { NextRequest, NextResponse } from 'next/server'
export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const { subdomain, orderId } = await req.json()
  const id = String(orderId || '61712')
  const sub = subdomain || 'minnies'

  const res = await fetch(`https://${sub}.shiprocket.co/tracking/order/${id}`, {
    headers: {
      'Accept': 'text/html,application/xhtml+xml',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept-Language': 'en-IN,en;q=0.9',
    },
    signal: AbortSignal.timeout(15000),
  })

  const html = await res.text()

  // Find where order_total, payment_method appear (or don't)
  const idx_total   = html.indexOf('order_total')
  const idx_payment = html.indexOf('payment_method')
  const idx_apidata = html.indexOf('apidata')
  const idx_tracking= html.indexOf('tracking_json')

  // Extract surrounding context for each hit
  const ctx = (idx: number) => idx >= 0 ? html.slice(Math.max(0,idx-50), idx+200) : null

  // Extract all <script> tag contents that might have data
  const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([^<]{5,})<\/script>/gi)]
    .map(m => m[1].trim())
    .filter(s => !s.startsWith('(') && !s.includes('google') && !s.includes('gtag') && !s.includes('fbq'))
    .map(s => s.slice(0, 500))
    .slice(0, 15)

  // Find any variable that looks like it has JSON order data
  const dataVars = [...html.matchAll(/(?:var|const|let|window\.)\s*(\w+)\s*=\s*({[^;]{20,500}})/gi)]
    .map(m => ({ name: m[1], value: m[2].slice(0, 300) }))
    .slice(0, 10)

  return NextResponse.json({
    htmlLength: html.length,
    idx_order_total: idx_total,
    idx_payment_method: idx_payment,
    idx_apidata: idx_apidata,
    idx_tracking_json: idx_tracking,
    context_order_total: ctx(idx_total),
    context_payment_method: ctx(idx_payment),
    context_apidata: ctx(idx_apidata),
    inlineScripts,
    dataVars,
    // Raw HTML chunks around key words
    html_0_1000: html.slice(0, 1000),
    html_around_apidata: idx_apidata >= 0 ? html.slice(idx_apidata - 100, idx_apidata + 800) : null,
  })
}
