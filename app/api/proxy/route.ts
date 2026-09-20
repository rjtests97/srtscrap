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
  const upper = html.toUpperCase()
  if (ORDER_STATUSES.some(s => upper.includes(s))) return parseArchivedPage(html, orderId)
  return null
}

const browserHeaders = {
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'User-Agent': UA,
  'Accept-Language': 'en-IN,en-GB;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Connection': 'keep-alive',
}

// Phase 1: fetch the direct tracking page. Returns a parsed Order, null (not found),
// 'rl' (rate limited), or the string '__NEEDS_AWB__' (HTTP 500 — needs fallback lookup)
async function fetchDirect(subdomain: string, orderId: string|number): Promise<any> {
  const id  = String(orderId)
  const url = `https://${subdomain}.shiprocket.co/tracking/order/${id}`
  const r1 = await tryFetch(url, browserHeaders)
  if (!r1) return 'rl'
  if (r1.status === 429 || r1.status === 503 || r1.status === 403) return 'rl'
  if (r1.status === 404) return null
  if (r1.status === 200) {
    const parsed = parseHtml(r1.html, orderId)
    if (parsed !== undefined) return parsed
    return 'rl'
  }
  if (r1.status === 500) return '__NEEDS_AWB__'
  return 'rl'
}

// Phase 2: AWB fallback lookup — called STRICTLY SEQUENTIALLY (never concurrent).
// apiv2.shiprocket.co/tracking-form-check gets unreliable under concurrent load
// even with staggering, so each order in this phase waits for the previous one.
async function resolveViaAwb(subdomain: string, orderId: string|number, companyId: number): Promise<any> {
  if (!companyId) {
    return { orderId, slug:'', orderDate:'N/A', orderTime:'N/A', dateYMD:null,
      value:'N/A', valueNum:0, payment:'N/A', status:'Archived', pincode:'N/A', location:'N/A' }
  }
  const lookupUrl = `https://apiv2.shiprocket.co/tracking-form-check?track_id=${orderId}&track_type=order_id&company_id=${companyId}`
  const lookupHeaders = {
    'Accept': 'application/json, text/plain, */*',
    'User-Agent': UA,
    'Referer': `https://${subdomain}.shiprocket.co/`,
    'Origin': `https://${subdomain}.shiprocket.co`,
  }

  let trackingUrl: string | null = null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(lookupUrl, { headers: lookupHeaders, signal: AbortSignal.timeout(8000) })
      if (res.ok) {
        const data = await res.json()
        trackingUrl = data?.url || null
        break
      }
    } catch {}
    if (attempt === 0) await sleep(600)
  }

  if (trackingUrl) {
    const awbRes = await tryFetch(trackingUrl, browserHeaders)
    if (awbRes?.status === 200) {
      const parsed = parseHtml(awbRes.html, orderId)
      if (parsed) return parsed
    }
  }

  return { orderId, slug:'', orderDate:'N/A', orderTime:'N/A', dateYMD:null,
    value:'N/A', valueNum:0, payment:'N/A', status:'Archived', pincode:'N/A', location:'N/A' }
}

export async function POST(req: NextRequest) {
  const { subdomain, ids, companyId } = await req.json() as { subdomain: string; ids: Array<string|number>; companyId?: number }
  const cid = companyId || 0

  // Phase 1: fetch all direct tracking pages in parallel with light stagger
  // (this endpoint is NOT rate-sensitive — evidence shows it handles concurrent load fine)
  const phase1 = await Promise.all(
    ids.map((id, i) =>
      sleep(i * 80)
        .then(() => fetchDirect(subdomain, id))
        .catch(() => 'rl' as const)
    )
  )

  // Phase 2: any order needing AWB fallback is resolved ONE AT A TIME, in sequence.
  // This is the slow but reliable path — apiv2.shiprocket.co breaks under concurrency.
  const results: any[] = [...phase1]
  for (let i = 0; i < results.length; i++) {
    if (results[i] === '__NEEDS_AWB__') {
      results[i] = await resolveViaAwb(subdomain, ids[i], cid)
    }
  }

  return NextResponse.json({ results })
}
