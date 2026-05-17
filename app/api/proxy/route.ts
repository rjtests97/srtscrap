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

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

// Min size of a real tracking page with order data (~160KB normally, use 40KB as RL threshold)
const MIN_REAL_PAGE_SIZE = 40000

async function fetchOneOrder(subdomain: string, orderId: string|number): Promise<any> {
  const id = String(orderId)

  try {
    const res = await fetch(`https://${subdomain}.shiprocket.co/tracking/order/${id}`, {
      headers: {
        'Accept': 'text/html,application/xhtml+xml',
        'User-Agent': UA,
        'Accept-Language': 'en-IN,en;q=0.9',
        'Cache-Control': 'no-cache',
      },
      signal: AbortSignal.timeout(12000),
    })

    // Explicit RL status codes
    if (res.status === 429 || res.status === 503 || res.status === 403) return 'rl'
    if (!res.ok) return null

    const html = await res.text()

    // KEY FIX: If page is too small, Shiprocket is rate-limiting us
    // Real tracking pages are ~150-170KB. A rate-limit/challenge page is tiny.
    if (html.length < MIN_REAL_PAGE_SIZE) {
      // Small page = rate limited or redirect, not a real response
      return 'rl'
    }

    const apidata = extractApidata(html)

    // apidata present but no order = order genuinely doesn't exist at this ID
    // apidata missing = page structure changed or partial load = treat as rl
    if (!apidata) return 'rl'

    if (!apidata.order?.order_date) {
      // Has apidata but no order data. Could be:
      // 1. Order ID doesn't belong to this brand (rare on brand's own subdomain)
      // 2. Order ID genuinely doesn't exist
      // Return null (genuine miss) only if page is full-sized
      return null
    }

    return parseApidata(apidata, orderId)
  } catch (e: any) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return 'rl'
    return 'rl'  // Any network error = treat as rl, not genuine null
  }
}

export async function POST(req: NextRequest) {
  const { subdomain, ids } = await req.json() as { subdomain: string; ids: Array<string|number> }
  const results = await Promise.all(ids.map(id => fetchOneOrder(subdomain, id).catch(() => 'rl')))
  return NextResponse.json({ results })
}
