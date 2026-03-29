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

function extractFromJson(json: any, originalId: string | number) {
  if (!json) return null
  // Try all known response structures
  const tj = json.tracking_json
    || json.data?.tracking_json
    || json.result?.tracking_json
    || json.response?.tracking_json
  if (tj?.order) return parseTJ(tj, originalId)
  // Sometimes the whole response IS the tracking data
  if (json.order?.order_id) return parseTJ(json, originalId)
  return null
}

async function fetchOneOrder(subdomain: string, orderId: string | number) {
  const id = String(orderId)
  const isAlpha = /[A-Za-z]/.test(id)

  const getHeaders = {
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-IN,en;q=0.9',
    'Referer': `https://${subdomain}.shiprocket.co/`,
    'X-Requested-With': 'XMLHttpRequest',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  }

  const tryGet = async (url: string) => {
    try {
      const res = await fetch(url, { headers: getHeaders, signal: AbortSignal.timeout(8000) })
      if (res.status === 429 || res.status === 403 || res.status === 503) return 'rl' as const
      if (!res.ok) return null
      const text = await res.text()
      if (!text || text.length < 5 || text.trimStart().startsWith('<')) return null
      return JSON.parse(text)
    } catch { return null }
  }

  const tryPost = async (url: string, body: any) => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { ...getHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      })
      if (res.status === 429 || res.status === 403 || res.status === 503) return 'rl' as const
      if (!res.ok) return null
      const text = await res.text()
      if (!text || text.length < 5 || text.trimStart().startsWith('<')) return null
      return JSON.parse(text)
    } catch { return null }
  }

  // ── GET endpoints ──────────────────────────────────
  const getUrls = [
    `https://${subdomain}.shiprocket.co/pocx/tracking/order/${id}`,
    `https://${subdomain}.shiprocket.co/api/v1/tracking/order/${id}`,
    `https://${subdomain}.shiprocket.co/api/v1/public/track/order/${id}`,
    `https://${subdomain}.shiprocket.co/api/external/track/order/${id}`,
  ]

  for (const url of getUrls) {
    const r = await tryGet(url)
    if (r === 'rl') return 'rl'
    const parsed = extractFromJson(r, orderId)
    if (parsed) return parsed
  }

  // ── POST endpoints (used by tracking pages with search forms) ──
  const postEndpoints = [
    // Standard tracking search
    { url: `https://${subdomain}.shiprocket.co/api/v1/external/track`, body: { order_id: id } },
    { url: `https://${subdomain}.shiprocket.co/api/v1/external/track`, body: { awb: id } },
    { url: `https://${subdomain}.shiprocket.co/pocx/tracking/search`, body: { order_id: id, type: 'order_id' } },
    { url: `https://${subdomain}.shiprocket.co/api/v1/tracking/search`, body: { query: id, type: 'order_id' } },
    { url: `https://${subdomain}.shiprocket.co/api/v1/tracking`, body: { order_id: id } },
  ]

  for (const { url, body } of postEndpoints) {
    const r = await tryPost(url, body)
    if (r === 'rl') return 'rl'
    const parsed = extractFromJson(r, orderId)
    if (parsed) return parsed
  }

  // ── Scrape tracking page HTML ──────────────────────
  // Last resort: get the page and extract __NEXT_DATA__
  try {
    const pageRes = await fetch(
      `https://${subdomain}.shiprocket.co/tracking/order/${id}`,
      {
        headers: {
          'Accept': 'text/html,application/xhtml+xml',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept-Language': 'en-IN,en;q=0.9',
        },
        signal: AbortSignal.timeout(12000),
      }
    )
    if (pageRes.ok) {
      const html = await pageRes.text()
      const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/)
      if (m) {
        const nd = JSON.parse(m[1])
        const pp = nd?.props?.pageProps
        const tj = pp?.trackingData?.tracking_json
              || pp?.tracking_json
              || pp?.data?.tracking_json
              || pp?.initialData?.tracking_json
        if (tj?.order) return parseTJ(tj, orderId)

        // Also check if pageProps has order data in a different shape
        if (pp?.orderDetails || pp?.trackingDetails) {
          const details = pp.orderDetails || pp.trackingDetails
          if (details?.tracking_json) return parseTJ(details.tracking_json, orderId)
        }
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
