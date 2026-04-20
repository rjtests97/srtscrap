import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'

const MONTHS: Record<string,string> = {
  Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',
  Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12'
}

function toYMD(s: string) {
  if (!s) return null
  const m1 = s.match(/^(\d{1,2})\s+(\w{3})\s+(\d{4})/)
  if (m1) return `${m1[3]}-${MONTHS[m1[2]]||'00'}-${m1[1].padStart(2,'0')}`
  const m2 = s.match(/^(\d{4}-\d{2}-\d{2})/)
  return m2 ? m2[1] : null
}

function buildOrder(tj: any, originalId: string|number) {
  if (!tj) return null
  const order = tj.order
  if (!order) return null
  const acts = tj.tracking_data?.shipment_track_activities ?? []
  const lastAct = acts.length > 0 ? acts[acts.length-1] : null
  const city = lastAct?.location || order.customer_city || order.billing_city || order.customer_state || 'N/A'
  const rawTime = acts[0]?.date || order.order_date || ''
  const orderDate = order.order_date ?? 'N/A'
  const slug = tj.company?.slug || ''
  if (!orderDate || orderDate === 'N/A') return null
  return {
    orderId:     originalId,
    slug,
    companyName: tj.company?.name || '',
    orderDate,
    orderTime:   rawTime.length >= 16 ? rawTime.slice(11,16) : 'N/A',
    dateYMD:     toYMD(orderDate),
    value:       order.order_total ? `Rs.${parseFloat(order.order_total).toFixed(2)}` : 'N/A',
    valueNum:    parseFloat(order.order_total) || 0,
    payment:     order.payment_method ?? 'N/A',
    status:      tj.shipment_status_text ?? 'N/A',
    pincode:     order.customer_pincode ?? 'N/A',
    location:    city,
  }
}

// Extract tracking_json from page HTML — tries multiple known patterns
function extractFromHtml(html: string, originalId: string|number) {
  // Pattern 1: apidata = {...} (old Shiprocket page format)
  const apiDataPatterns = [
    /var\s+apidata\s*=\s*'([^']+)'/,
    /var\s+apidata\s*=\s*"([^"]+)"/,
    /apidata\s*=\s*'([^']+)'/,
    /apidata\s*=\s*({[\s\S]+?});/,
    /"apidata"\s*:\s*({[\s\S]+?})\s*[,}]/,
  ]
  for (const pat of apiDataPatterns) {
    const m = html.match(pat)
    if (m) {
      try {
        const raw = m[1].startsWith('{') ? m[1] : decodeURIComponent(m[1])
        const json = JSON.parse(raw)
        const tj = json?.tracking_json || json
        const result = buildOrder(tj, originalId)
        if (result) return result
      } catch {}
    }
  }

  // Pattern 2: __NEXT_DATA__ (newer Next.js pages)
  const ndMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/)
  if (ndMatch) {
    try {
      const nd = JSON.parse(ndMatch[1])
      const pp = nd?.props?.pageProps
      const tj = pp?.trackingData?.tracking_json || pp?.tracking_json || pp?.data?.tracking_json
      const result = buildOrder(tj, originalId)
      if (result) return result
    } catch {}
  }

  // Pattern 3: window.__SR_DATA__ or similar global vars
  const globalPatterns = [
    /window\.__SR_DATA__\s*=\s*({[\s\S]+?});/,
    /window\.__TRACKING_DATA__\s*=\s*({[\s\S]+?});/,
    /self\.__apiData\s*=\s*({[\s\S]+?});/,
  ]
  for (const pat of globalPatterns) {
    const m = html.match(pat)
    if (m) {
      try {
        const json = JSON.parse(m[1])
        const tj = json?.tracking_json || json
        const result = buildOrder(tj, originalId)
        if (result) return result
      } catch {}
    }
  }

  // Pattern 4: tracking_json embedded as JSON string anywhere in page
  const tjMatch = html.match(/"tracking_json"\s*:\s*({[\s\S]+?"company"[\s\S]+?"order"\s*:\s*{[\s\S]+?}[\s\S]+?})\s*[,}]/)
  if (tjMatch) {
    try {
      const tj = JSON.parse(tjMatch[1])
      const result = buildOrder(tj, originalId)
      if (result) return result
    } catch {}
  }

  return null
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

async function fetchOneOrder(subdomain: string, orderId: string|number): Promise<any> {
  const id = String(orderId)

  // Step 1: Try the JSON API first (fast, ~300ms)
  try {
    const res = await fetch(`https://${subdomain}.shiprocket.co/pocx/tracking/order/${id}`, {
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Referer': `https://${subdomain}.shiprocket.co/tracking/order/${id}`,
        'Origin': `https://${subdomain}.shiprocket.co`,
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': UA,
      },
      signal: AbortSignal.timeout(8000),
    })
    if (res.status === 429 || res.status === 403 || res.status === 503) return 'rl'
    if (res.ok) {
      const text = await res.text()
      if (text && !text.startsWith('<')) {
        const json = JSON.parse(text)
        const tj = json?.tracking_json
        // Only use if it has actual order data
        if (tj?.order?.order_id) {
          const result = buildOrder(tj, orderId)
          if (result) return result
        }
      }
    }
  } catch {}

  // Step 2: Fetch the tracking page HTML and parse it
  try {
    const res = await fetch(`https://${subdomain}.shiprocket.co/tracking/order/${id}`, {
      headers: {
        'Accept': 'text/html,application/xhtml+xml',
        'User-Agent': UA,
        'Accept-Language': 'en-IN,en;q=0.9',
      },
      signal: AbortSignal.timeout(12000),
    })
    if (res.status === 429 || res.status === 503 || res.status === 403) return 'rl'
    if (!res.ok) return null
    const html = await res.text()
    const result = extractFromHtml(html, orderId)
    if (result) return result
  } catch {}

  return null
}

export async function POST(req: NextRequest) {
  const { subdomain, ids } = await req.json() as { subdomain: string; ids: Array<string|number> }
  const results = await Promise.all(ids.map(id => fetchOneOrder(subdomain, id).catch(() => null)))
  return NextResponse.json({ results })
}
