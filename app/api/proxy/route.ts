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

// Extract var apidata = {...} from full tracking page
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

// Parse a full apidata object (regular tracking page)
function parseApidata(apidata: any, originalId: string|number) {
  if (!apidata) return null
  const order     = apidata.order
  const orderDate = order?.order_date || ''
  const status    = apidata.shipment_status_text || ''
  if (!orderDate && !status) return null

  const acts    = apidata.tracking_data?.shipment_track_activities ?? []
  const lastAct = acts.length > 0 ? acts[acts.length-1] : null
  const city    = lastAct?.location || order?.customer_city || order?.customer_state || 'N/A'
  const rawTime = acts[0]?.date || orderDate || ''

  return {
    orderId:   originalId,
    slug:      apidata.company?.slug || '',
    orderDate: orderDate || 'N/A',
    orderTime: rawTime.length >= 16 ? rawTime.slice(11,16) : 'N/A',
    dateYMD:   toYMD(orderDate),
    value:     order?.order_total ? `Rs.${parseFloat(order.order_total).toFixed(2)}` : 'N/A',
    valueNum:  parseFloat(order?.order_total||'0') || 0,
    payment:   order?.payment_method || 'N/A',
    status:    status || 'N/A',
    pincode:   order?.customer_pincode || 'N/A',
    location:  city,
  }
}

// STATUS keywords that confirm this is a real order page
const ORDER_STATUSES = [
  'DELIVERED','RTO DELIVERED','CANCELLED','IN TRANSIT',
  'OUT FOR DELIVERY','PENDING','UNDELIVERED','PICKUP GENERATED',
  'SHIPPED','AT DESTINATION HUB','REACHED','RTO OFD',
  'RTO IN TRANSIT','RTO INITIATED','ATTEMPT FAILURE',
  'OUT FOR PICKUP','MISROUTED','UNTRACEABLE'
]

// Parse archived tracking page — "This is an archived tracking view. Verify as buyer"
// These have no var apidata but contain status info in visible HTML
function parseArchivedPage(html: string, originalId: string|number) {
  // Extract status — look for known status keywords in HTML text
  let status = 'N/A'
  const upperHtml = html.toUpperCase()
  for (const s of ORDER_STATUSES) {
    if (upperHtml.includes(s)) { status = s.charAt(0) + s.slice(1).toLowerCase(); break }
  }

  // Extract first full date visible in the page e.g. "12 Aug 2026"
  const dateMatch = html.match(/\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})\b/i)
  const orderDate = dateMatch ? `${dateMatch[1]} ${dateMatch[2]} ${dateMatch[3]}` : 'N/A'
  const dateYMD   = dateMatch ? toYMD(orderDate) : null

  // Extract pincode (6-digit number)
  const pinMatch = html.match(/\b(\d{6})\b/)
  const pincode  = pinMatch ? pinMatch[1] : 'N/A'

  return {
    orderId:   originalId,
    slug:      '',
    orderDate,
    orderTime: 'N/A',
    dateYMD,
    value:     'N/A',
    valueNum:  0,
    payment:   'N/A',
    status,
    pincode,
    location:  'N/A',
  }
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
const MIN_REAL_PAGE = 40000  // rate-limit/challenge pages are tiny

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

    // Rate limiting
    if (res.status === 429 || res.status === 503 || res.status === 403) return 'rl'

    // HTTP 500 = Shiprocket backend error for this order (common for archived orders)
    // The order EXISTS but Shiprocket can't serve it from the server side
    // Return a stub so the scanner counts it as found and keeps going
    if (res.status === 500) {
      return {
        orderId, slug: '', orderDate: 'N/A', orderTime: 'N/A', dateYMD: null,
        value: 'N/A', valueNum: 0, payment: 'N/A', status: 'Archived',
        pincode: 'N/A', location: 'N/A',
      }
    }

    if (!res.ok) return null  // 404 = genuinely doesn't exist
    const html = await res.text()

    // Small page = rate-limit challenge page
    if (html.length < MIN_REAL_PAGE) return 'rl'

    // ── Regular tracking page with var apidata ──
    const apidata = extractApidata(html)
    if (apidata) {
      const result = parseApidata(apidata, orderId)
      if (result) return result
      return null  // apidata exists but empty = order not found
    }

    // ── Archived tracking page (no apidata, different HTML template) ──
    const upperHtml = html.toUpperCase()
    if (ORDER_STATUSES.some(s => upperHtml.includes(s))) {
      return parseArchivedPage(html, orderId)
    }

    return 'rl'  // full page but unrecognised format

  } catch (e: any) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return 'rl'
    return 'rl'
  }
}

export async function POST(req: NextRequest) {
  const { subdomain, ids } = await req.json() as { subdomain: string; ids: Array<string|number> }
  const results = await Promise.all(ids.map(id => fetchOneOrder(subdomain, id).catch(() => 'rl')))
  return NextResponse.json({ results })
}
