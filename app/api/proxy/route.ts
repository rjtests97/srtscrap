import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'

// Parse tracking_json into Order object
function parseTrackingJson(tj: any, orderId: string | number) {
  if (!tj?.order?.order_id) return null
  const order = tj.order
  const acts = tj.tracking_data?.shipment_track_activities ?? []
  const lastAct = acts.length > 0 ? acts[acts.length - 1] : null
  const city = lastAct?.location || order.customer_city || order.billing_city || order.customer_state || 'N/A'
  const rawTime = acts[0]?.date || order.order_date || ''
  const MONTHS: Record<string, string> = {Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12'}
  const toYMD = (s: string) => {
    if (!s) return null
    const m1 = s.match(/^(\d{1,2})\s+(\w{3})\s+(\d{4})/)
    if (m1) return `${m1[3]}-${MONTHS[m1[2]] || '00'}-${m1[1].padStart(2, '0')}`
    const m2 = s.match(/^(\d{4}-\d{2}-\d{2})/)
    return m2 ? m2[1] : null
  }
  return {
    orderId,
    slug: tj.company?.slug || '',
    companyName: tj.company?.name || '',
    orderDate: order.order_date ?? 'N/A',
    orderTime: rawTime.length >= 16 ? rawTime.slice(11, 16) : 'N/A',
    dateYMD: toYMD(order.order_date || ''),
    value: order.order_total ? `Rs.${parseFloat(order.order_total).toFixed(2)}` : 'N/A',
    valueNum: parseFloat(order.order_total) || 0,
    payment: order.payment_method ?? 'N/A',
    status: tj.shipment_status_text ?? 'N/A',
    pincode: order.customer_pincode ?? 'N/A',
    location: city,
  }
}

async function fetchOneOrder(subdomain: string, orderId: string | number) {
  const id = String(orderId)

  // Try endpoint 1: /pocx/tracking/order/{id} (works for numeric IDs)
  // Try endpoint 2: /api/v1/tracking/order/{id} (may work for alphanumeric)
  // Try endpoint 3: extract from tracking page __NEXT_DATA__ (fallback)
  const endpoints = [
    `https://${subdomain}.shiprocket.co/pocx/tracking/order/${id}`,
    `https://${subdomain}.shiprocket.co/api/v1/tracking/order/${id}`,
  ]

  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'Referer': `https://${subdomain}.shiprocket.co/`,
          'X-Requested-With': 'XMLHttpRequest',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
        signal: AbortSignal.timeout(8000),
      })

      if (res.status === 429 || res.status === 403 || res.status === 503) return 'rl'
      if (!res.ok) continue

      const text = await res.text()
      if (!text || text.includes('<html') || text.includes('<!DOCTYPE')) continue

      let json: any
      try { json = JSON.parse(text) } catch { continue }

      const tj = json?.tracking_json
      if (tj?.order?.order_id) return parseTrackingJson(tj, orderId)

      // Some responses wrap differently
      if (json?.data?.tracking_json) return parseTrackingJson(json.data.tracking_json, orderId)
    } catch { continue }
  }

  // Fallback: scrape the public tracking page for __NEXT_DATA__
  try {
    const pageRes = await fetch(
      `https://${subdomain}.shiprocket.co/tracking/order/${id}`,
      {
        headers: {
          'Accept': 'text/html,application/xhtml+xml',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        signal: AbortSignal.timeout(10000),
      }
    )
    if (!pageRes.ok) return null
    const html = await pageRes.text()

    // Extract __NEXT_DATA__ JSON from the page
    const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/)
    if (match) {
      const nextData = JSON.parse(match[1])
      const props = nextData?.props?.pageProps
      const tj = props?.trackingData?.tracking_json
                || props?.tracking_json
                || props?.data?.tracking_json
      if (tj?.order?.order_id) return parseTrackingJson(tj, orderId)
    }
  } catch {}

  return null
}

export async function POST(req: NextRequest) {
  const { subdomain, ids } = await req.json() as { subdomain: string; ids: Array<string | number> }

  const results = await Promise.all(ids.map(id => fetchOneOrder(subdomain, id)))

  return NextResponse.json({ results })
}
