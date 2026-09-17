import { NextRequest, NextResponse } from 'next/server'
export const runtime = 'nodejs'

function extractApidata(html: string): any {
  const idx = html.indexOf('var apidata = ')
  if (idx < 0) return null
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
  const id = String(orderId || '70932')
  const sub = subdomain || 'minnies'

  const res = await fetch(`https://${sub}.shiprocket.co/tracking/order/${id}`, {
    headers: {
      'Accept': 'text/html',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept-Language': 'en-IN,en;q=0.9',
    },
    signal: AbortSignal.timeout(15000),
  })
  const html = await res.text()
  const apidata = extractApidata(html)

  // Search entire apidata for payment-related fields
  const flat: Record<string,any> = {}
  function flattenObj(obj: any, prefix = '') {
    if (!obj || typeof obj !== 'object') return
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
        flattenObj(v, key)
      } else {
        flat[key] = v
      }
    }
  }
  flattenObj(apidata)

  const paymentFields = Object.entries(flat).filter(([k]) =>
    k.toLowerCase().includes('pay') || k.toLowerCase().includes('cod') || k.toLowerCase().includes('method')
  )
  const totalFields = Object.entries(flat).filter(([k]) =>
    k.toLowerCase().includes('total') || k.toLowerCase().includes('amount') || k.toLowerCase().includes('price') || k.toLowerCase().includes('value')
  )

  return NextResponse.json({
    pageLength: html.length,
    hasApidata: !!apidata,
    show_pii: apidata?.show_pii,
    shipment_status: apidata?.shipment_status_text,
    order_keys: apidata?.order ? Object.keys(apidata.order) : null,
    order_full: apidata?.order,
    payment_fields: paymentFields,
    total_fields: totalFields,
    // First tracking activity
    first_activity: apidata?.tracking_data?.shipment_track_activities?.[0],
  })
}
