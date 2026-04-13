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
  if (!tj?.order) return null
  const order = tj.order
  const orderId = order.order_id || originalId
  const acts = tj.tracking_data?.shipment_track_activities ?? []
  const lastAct = acts.length > 0 ? acts[acts.length-1] : null
  const city = lastAct?.location || order.customer_city || order.billing_city || order.customer_state || 'N/A'
  const rawTime = acts[0]?.date || order.order_date || ''
  return {
    orderId,
    slug:        tj.company?.slug || '',
    companyName: tj.company?.name || '',
    orderDate:   order.order_date ?? 'N/A',
    orderTime:   rawTime.length >= 16 ? rawTime.slice(11,16) : 'N/A',
    dateYMD:     toYMD(order.order_date || ''),
    value:       order.order_total ? `Rs.${parseFloat(order.order_total).toFixed(2)}` : 'N/A',
    valueNum:    parseFloat(order.order_total) || 0,
    payment:     order.payment_method ?? 'N/A',
    status:      tj.shipment_status_text ?? 'N/A',
    pincode:     order.customer_pincode ?? 'N/A',
    location:    city,
  }
}

const UAS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
]
let uaIdx = 0

async function fetchOneOrder(subdomain: string, orderId: string|number): Promise<any> {
  const id = String(orderId)
  const ua = UAS[uaIdx % UAS.length]; uaIdx++

  const headers: Record<string,string> = {
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-IN,en-US;q=0.9,en;q=0.8',
    'Referer': `https://${subdomain}.shiprocket.co/tracking/order/${id}`,
    'Origin': `https://${subdomain}.shiprocket.co`,
    'X-Requested-With': 'XMLHttpRequest',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'User-Agent': ua,
    'Cache-Control': 'no-cache',
  }

  try {
    const res = await fetch(
      `https://${subdomain}.shiprocket.co/pocx/tracking/order/${id}`,
      { headers, signal: AbortSignal.timeout(12000) }
    )
    if ([429, 503, 502, 403].includes(res.status)) return 'rl'
    if (!res.ok) return null
    const text = await res.text()
    if (!text || text.length < 5 || text.trimStart().startsWith('<')) return 'rl'
    let json: any
    try { json = JSON.parse(text) } catch { return 'rl' }
    const tj = json?.tracking_json
    if (!tj || !tj.order) return null
    return parseTJ(tj, orderId)
  } catch (e: any) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return 'rl'
    return null
  }
}

export async function POST(req: NextRequest) {
  const { subdomain, ids } = await req.json() as { subdomain: string; ids: Array<string|number> }
  const results = await Promise.all(ids.map(id => fetchOneOrder(subdomain, id).catch(() => null)))
  return NextResponse.json({ results })
}
