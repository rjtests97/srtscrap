import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'

const MONTHS: Record<string,string> = {Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12'}

function toYMD(s: string) {
  if (!s) return null
  const m1 = s.match(/^(\d{1,2})\s+(\w{3})\s+(\d{4})/)
  if (m1) return `${m1[3]}-${MONTHS[m1[2]]||'00'}-${m1[1].padStart(2,'0')}`
  const m2 = s.match(/^(\d{4}-\d{2}-\d{2})/)
  return m2 ? m2[1] : null
}

function parseTJ(tj: any, originalId: string|number) {
  // tj = the tracking_json object
  if (!tj) return null
  const order = tj.order
  if (!order) return null
  const orderId = order.order_id || originalId
  const acts = tj.tracking_data?.shipment_track_activities ?? []
  const lastAct = acts.length > 0 ? acts[acts.length-1] : null
  const city = lastAct?.location || order.customer_city || order.billing_city || order.customer_state || 'N/A'
  const rawTime = acts[0]?.date || order.order_date || ''
  const dateYMD = toYMD(order.order_date || '')
  return {
    orderId,
    slug:        tj.company?.slug || '',
    companyName: tj.company?.name || '',
    orderDate:   order.order_date ?? 'N/A',
    orderTime:   rawTime.length >= 16 ? rawTime.slice(11,16) : 'N/A',
    dateYMD,
    value:       order.order_total ? `Rs.${parseFloat(order.order_total).toFixed(2)}` : 'N/A',
    valueNum:    parseFloat(order.order_total) || 0,
    payment:     order.payment_method ?? 'N/A',
    status:      tj.shipment_status_text ?? 'N/A',
    pincode:     order.customer_pincode ?? 'N/A',
    location:    city,
  }
}

async function fetchOneOrder(subdomain: string, orderId: string|number): Promise<any> {
  const id = String(orderId)
  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-IN,en;q=0.9',
    'Referer': `https://${subdomain}.shiprocket.co/`,
    'X-Requested-With': 'XMLHttpRequest',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  }

  try {
    const res = await fetch(
      `https://${subdomain}.shiprocket.co/pocx/tracking/order/${id}`,
      { headers, signal: AbortSignal.timeout(10000) }
    )
    if (res.status === 429 || res.status === 503) return 'rl'
    if (!res.ok) return null
    const text = await res.text()
    if (!text || text.length < 5) return 'rl'
    if (text.trimStart().startsWith('<')) return 'rl'
    const json = JSON.parse(text)
    const tj = json?.tracking_json
    if (!tj) return null
    // If order is missing entirely, this is a rate-limit/config-only response
    if (!tj.order) return null
    return parseTJ(tj, orderId)
  } catch (e: any) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return 'rl'
    return null
  }
}

export async function POST(req: NextRequest) {
  const { subdomain, ids } = await req.json() as { subdomain: string; ids: Array<string|number> }
  const results = await Promise.all(ids.map(id => fetchOneOrder(subdomain, id).catch(()=>null)))
  return NextResponse.json({ results })
}
