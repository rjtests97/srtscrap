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

const ORDER_STATUSES = ['DELIVERED','RTO DELIVERED','CANCELLED','IN TRANSIT','OUT FOR DELIVERY',
  'PENDING','UNDELIVERED','PICKUP GENERATED','SHIPPED','AT DESTINATION','REACHED','RTO OFD',
  'RTO IN TRANSIT','RTO INITIATED','ATTEMPT FAILURE','OUT FOR PICKUP','MISROUTED','UNTRACEABLE']

function parseArchivedPage(html: string, originalId: string|number) {
  const upper = html.toUpperCase()
  let status = 'N/A'
  for (const s of ORDER_STATUSES) {
    if (upper.includes(s)) { status = s.charAt(0) + s.slice(1).toLowerCase(); break }
  }
  const dateMatch = html.match(/\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})\b/i)
  const orderDate = dateMatch ? `${dateMatch[1]} ${dateMatch[2]} ${dateMatch[3]}` : 'N/A'
  const pinMatch  = html.match(/\b(\d{6})\b/)
  return {
    orderId: originalId, slug: '', orderDate, orderTime: 'N/A',
    dateYMD: dateMatch ? toYMD(orderDate) : null,
    value: 'N/A', valueNum: 0, payment: 'N/A',
    status: status !== 'N/A' ? status : 'Archived',
    pincode: pinMatch?.[1] || 'N/A', location: 'N/A',
  }
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
const MIN_REAL_PAGE = 40000
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function tryFetch(url: string, headers: any): Promise<{status:number, html:string}|null> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(12000) })
    const html = await res.text()
    return { status: res.status, html }
  } catch { return null }
}

function parseHtml(html: string, orderId: string|number) {
  if (html.length < MIN_REAL_PAGE) return null  // too small = challenge page
  const apidata = extractApidata(html)
  if (apidata) {
    const result = parseApidata(apidata, orderId)
    if (result) return result
    return null  // apidata found but empty = order doesn't exist
  }
  // No apidata — try archived page format
  const upper = html.toUpperCase()
  if (ORDER_STATUSES.some(s => upper.includes(s))) return parseArchivedPage(html, orderId)
  return null
}

async function fetchOneOrder(subdomain: string, orderId: string|number): Promise<any> {
  const id  = String(orderId)
  const url = `https://${subdomain}.shiprocket.co/tracking/order/${id}`
  const headers = {
    // Mimic a real browser navigation — Shiprocket returns 500 for fetch-style requests
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'User-Agent': UA,
    'Accept-Language': 'en-IN,en-GB;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Upgrade-Insecure-Requests': '1',
    // Sec-Fetch headers distinguish navigation from fetch — Shiprocket blocks fetch mode
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Connection': 'keep-alive',
  }

  // ── Attempt 1 ──────────────────────────────────────────
  const r1 = await tryFetch(url, headers)
  if (!r1) return 'rl'

  if (r1.status === 429 || r1.status === 503 || r1.status === 403) return 'rl'
  if (r1.status === 404) return null  // genuinely doesn't exist

  if (r1.status === 200) {
    const parsed = parseHtml(r1.html, orderId)
    // parsed = Order → found, null → not found, undefined handled below
    if (parsed !== undefined) return parsed  // includes null for not-found
    return 'rl'  // full page but unrecognised format
  }

  if (r1.status === 500) {
    // 500 can be transient throttling OR genuine archived order
    // Retry once after a pause — transient 500s resolve, genuine ones don't
    await sleep(1500)

    const r2 = await tryFetch(url, headers)
    if (!r2) return 'rl'

    if (r2.status === 200) {
      const parsed2 = parseHtml(r2.html, orderId)
      if (parsed2 !== undefined) return parsed2
      return 'rl'
    }

    if (r2.status === 429 || r2.status === 503) return 'rl'

    // Both attempts returned 500 (or other error) → persistent failure
    // Order exists (it's on the brand subdomain) but data is unavailable
    return {
      orderId, slug: '', orderDate: 'N/A', orderTime: 'N/A', dateYMD: null,
      value: 'N/A', valueNum: 0, payment: 'N/A', status: 'Archived',
      pincode: 'N/A', location: 'N/A',
    }
  }

  return 'rl'  // any other status
}

export async function POST(req: NextRequest) {
  const { subdomain, ids } = await req.json() as { subdomain: string; ids: Array<string|number> }
  // Stagger parallel requests slightly to reduce server-side throttling
  const results = await Promise.all(
    ids.map((id, i) =>
      sleep(i * 150)  // 150ms stagger: 0ms, 150ms, 300ms... for a batch of 8
        .then(() => fetchOneOrder(subdomain, id))
        .catch(() => 'rl' as const)
    )
  )
  return NextResponse.json({ results })
}
