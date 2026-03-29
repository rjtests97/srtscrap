import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'

const MONTHS: Record<string, string> = {
  Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',
  Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12'
}

function toYMD(s: string) {
  if (!s) return null
  const m1 = s.match(/^(\d{1,2})\s+(\w{3})\s+(\d{4})/)
  if (m1) return `${m1[3]}-${MONTHS[m1[2]] || '00'}-${m1[1].padStart(2, '0')}`
  const m2 = s.match(/^(\d{4}-\d{2}-\d{2})/)
  return m2 ? m2[1] : null
}

function parseTJ(tj: any, originalId: string | number) {
  if (!tj?.order) return null
  const order = tj.order
  // Use the order_id from response if available, else use what we passed in
  const orderId = order.order_id || originalId
  if (!orderId) return null
  const acts = tj.tracking_data?.shipment_track_activities ?? []
  const lastAct = acts.length > 0 ? acts[acts.length - 1] : null
  const city = lastAct?.location || order.customer_city || order.billing_city || order.customer_state || 'N/A'
  const rawTime = acts[0]?.date || order.order_date || ''
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

async function tryFetch(url: string, headers: Record<string, string>) {
  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(9000),
    })
    if (res.status === 429 || res.status === 403 || res.status === 503) return 'rl'
    if (!res.ok) return null
    const text = await res.text()
    if (!text || text.length < 10) return null
    if (text.trimStart().startsWith('<')) return null // HTML response
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function fetchOneOrder(subdomain: string, orderId: string | number) {
  const id = String(orderId)
  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-IN,en;q=0.9',
    'Referer': `https://${subdomain}.shiprocket.co/`,
    'X-Requested-With': 'XMLHttpRequest',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  }

  // Endpoint 1: standard pocx API (works for numeric IDs like 61000)
  const r1 = await tryFetch(`https://${subdomain}.shiprocket.co/pocx/tracking/order/${id}`, headers)
  if (r1 === 'rl') return 'rl'
  if (r1?.tracking_json) return parseTJ(r1.tracking_json, orderId)
  if (r1?.data?.tracking_json) return parseTJ(r1.data.tracking_json, orderId)

  // Endpoint 2: v1 API (sometimes used for alphanumeric)
  const r2 = await tryFetch(`https://${subdomain}.shiprocket.co/api/v1/tracking/order/${id}`, headers)
  if (r2 === 'rl') return 'rl'
  if (r2?.tracking_json) return parseTJ(r2.tracking_json, orderId)
  if (r2?.data?.tracking_json) return parseTJ(r2.data.tracking_json, orderId)

  // Endpoint 3: public tracking API (used by the tracking page)
  const r3 = await tryFetch(`https://${subdomain}.shiprocket.co/api/v1/public/track/order/${id}`, headers)
  if (r3 === 'rl') return 'rl'
  if (r3?.tracking_json) return parseTJ(r3.tracking_json, orderId)
  if (r3?.data?.tracking_json) return parseTJ(r3.data.tracking_json, orderId)

  // Endpoint 4: try without subdomain via main shiprocket domain
  const r4 = await tryFetch(`https://shiprocket.co/tracking/api/order/${id}?subdomain=${subdomain}`, {
    ...headers, 'Referer': `https://${subdomain}.shiprocket.co/`
  })
  if (r4 === 'rl') return 'rl'
  if (r4?.tracking_json) return parseTJ(r4.tracking_json, orderId)

  // Endpoint 5: scrape the tracking page and extract __NEXT_DATA__
  try {
    const pageRes = await fetch(`https://${subdomain}.shiprocket.co/tracking/order/${id}`, {
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept-Language': 'en-IN,en;q=0.9',
      },
      signal: AbortSignal.timeout(12000),
    })
    if (pageRes.ok) {
      const html = await pageRes.text()
      const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/)
      if (m) {
        const nd = JSON.parse(m[1])
        const pp = nd?.props?.pageProps
        const tj = pp?.trackingData?.tracking_json || pp?.tracking_json || pp?.data?.tracking_json
        if (tj?.order) return parseTJ(tj, orderId)
      }
    }
  } catch {}

  return null
}

export async function POST(req: NextRequest) {
  const { subdomain, ids } = await req.json() as {
    subdomain: string
    ids: Array<string | number>
  }

  const results = await Promise.all(
    ids.map(id => fetchOneOrder(subdomain, id).catch(() => null))
  )

  return NextResponse.json({ results })
}
