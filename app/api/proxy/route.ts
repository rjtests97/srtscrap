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

// Extract var apidata = {...} from page HTML
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

function parseApidata(apidata: any, originalId: string|number) {
  if (!apidata?.order?.order_date) return null
  const order = apidata.order
  const company = apidata.company
  const acts = apidata.tracking_data?.shipment_track_activities ?? []
  const lastAct = acts.length > 0 ? acts[acts.length-1] : null
  const city = lastAct?.location || order.customer_city || order.billing_city || order.customer_state || 'N/A'
  const rawTime = acts[0]?.date || order.order_date || ''
  return {
    orderId:     originalId,
    slug:        company?.slug || '',
    companyName: company?.name || '',
    orderDate:   order.order_date,
    orderTime:   rawTime.length >= 16 ? rawTime.slice(11,16) : 'N/A',
    dateYMD:     toYMD(order.order_date),
    value:       order.order_total ? `Rs.${parseFloat(order.order_total).toFixed(2)}` : 'N/A',
    valueNum:    parseFloat(order.order_total) || 0,
    payment:     order.payment_method || 'N/A',
    status:      apidata.shipment_status_text || 'N/A',
    pincode:     order.customer_pincode || 'N/A',
    location:    city,
  }
}

// Rotate through a few realistic browser UA strings so concurrent requests
// don't all look identical (a common bot-detection signal).
const UAS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
]

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const COURIERS = ['Blue Dart','Delhivery','DTDC','Ekart','Xpressbees','Amazon Shipping','India Post','Shadowfax','Ecom Express','Smartr','Bluedart','Shree Maruti','Professional','DP World']

// Archived tracking pages hide the order behind buyer-OTP verification, so the
// full `apidata` blob is gone. We still scrape the bits that remain public:
// status, courier, AWB, delivered date, and the (day-masked) placed month.
// The order-placed DAY is masked, so dateYMD stays null — these orders are
// counted in manual scans but excluded from date-range / revenue analytics.
function parseArchived(html: string, orderId: string|number): any {
  const pick = (re: RegExp) => { const m = html.match(re); return m ? m[1].trim() : '' }
  const status = pick(/class="status-value[^"]*"[^>]*>\s*([^<]+?)\s*</i) || 'ARCHIVED'
  const deliveredDate = pick(/class="delivered-date"[^>]*>\s*([^<]+?)\s*</i)
  const awb = pick(/data-awb="([^"]+)"/i)
  const courier = COURIERS.find(c => new RegExp(c.replace(/\s+/g, '\\s+'), 'i').test(html)) || ''
  // "Order Placed On ** May 2026" — day masked, month/year still visible
  const monthYear = pick(/Placed On[\s\S]{0,80}?\*+\s*([A-Za-z]{3,9}\s+20\d{2})/i)
  return {
    orderId,
    slug:        courier ? courier.toLowerCase().replace(/\s+/g, '') : '',
    companyName: courier,
    orderDate:   monthYear || deliveredDate || 'Archived',
    orderTime:   'N/A',
    dateYMD:     null,                 // placed-day masked → cannot pin a calendar day
    value:       'N/A',
    valueNum:    0,
    payment:     'N/A',
    status:      status.toUpperCase(),
    pincode:     'N/A',
    location:    'N/A',
    archived:    true,
    awb:         awb || null,
    deliveredDate: deliveredDate || null,
  }
}

// Single raw attempt. Returns 'rl' for transient/throttle signals, null for a
// genuine miss, or the parsed order.
async function attemptOnce(subdomain: string, orderId: string|number): Promise<any> {
  const id = String(orderId)
  const ua = UAS[Math.floor(Math.random() * UAS.length)]
  const origin = `https://${subdomain}.shiprocket.co`

  const res = await fetch(`${origin}/tracking/order/${id}`, {
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'User-Agent': ua,
      'Accept-Language': 'en-IN,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Referer': `${origin}/`,
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-User': '?1',
      'sec-ch-ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
    },
    signal: AbortSignal.timeout(12000),
  })

  // Explicit RL status codes
  if (res.status === 429 || res.status === 503 || res.status === 403) return 'rl'
  if (!res.ok) return null

  const html = await res.text()
  const title = (html.match(/<title>([^<]*)<\/title>/i)?.[1] || '').toLowerCase()

  // Classify by page CONTENT, not size. Shiprocket now serves three kinds of
  // page where it used to serve only the full tracking page:
  //   1. Full tracking page  → has `var apidata`           → parse fully
  //   2. "Order Tracking - Archived" → OTP-gated real order → parse partial
  //   3. "AWB Not Found"      → order genuinely doesn't exist → null (true end)

  // Genuine miss — the real end of the ID range.
  if (title.includes('not found') || /order\s+not\s+found|does\s+not\s+exist/i.test(html)) return null

  // Archived order — real order with public data behind OTP. Scrape what's left.
  if (title.includes('archived') || /archived tracking view/i.test(html)) {
    return parseArchived(html, orderId)
  }

  // Full tracking page with embedded order data.
  const apidata = extractApidata(html)
  if (apidata) {
    if (!apidata.order?.order_date) return null
    return parseApidata(apidata, orderId)
  }

  // Unrecognized page with no order structure (e.g. a Cloudflare/WAF
  // interstitial) — genuinely retryable.
  return 'rl'
}

async function fetchOneOrder(subdomain: string, orderId: string|number): Promise<any> {
  // Retry transient 'rl' once with a short backoff before declaring rate-limit.
  // A single WAF challenge / cold response shouldn't poison the whole burst.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await attemptOnce(subdomain, orderId)
      if (r !== 'rl') return r          // genuine miss or real order — done
      if (attempt === 0) await sleep(400 + Math.random() * 400)
    } catch (e: any) {
      // Timeout / network error — retry once, then treat as rl
      if (attempt === 0) await sleep(400 + Math.random() * 400)
    }
  }
  return 'rl'
}

export async function POST(req: NextRequest) {
  const { subdomain, ids } = await req.json() as { subdomain: string; ids: Array<string|number> }
  // Light stagger so a batch doesn't hit the origin at the exact same instant
  // (cheap insurance against tripping a real limit under sustained load).
  const results = await Promise.all(
    ids.map((id, i) =>
      sleep(i * 60 + Math.random() * 40)
        .then(() => fetchOneOrder(subdomain, id))
        .catch(() => 'rl')
    )
  )
  return NextResponse.json({ results })
}
