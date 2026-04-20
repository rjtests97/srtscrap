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

// Parse order from tracking_json object (old API — still works for some orders)
function parseFromTJ(tj: any, originalId: string|number) {
  if (!tj?.order?.order_id) return null
  const order = tj.order
  const acts = tj.tracking_data?.shipment_track_activities ?? []
  const lastAct = acts.length > 0 ? acts[acts.length-1] : null
  const city = lastAct?.location || order.customer_city || order.billing_city || order.customer_state || 'N/A'
  const rawTime = acts[0]?.date || order.order_date || ''
  return {
    orderId:     originalId,
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

// Parse order from page HTML __NEXT_DATA__ (new method — works when API returns empty)
function parseFromNextData(nd: any, originalId: string|number) {
  try {
    const pp = nd?.props?.pageProps
    const tj = pp?.trackingData?.tracking_json || pp?.tracking_json || pp?.data?.tracking_json
    if (!tj) return null

    const order  = tj.order
    const acts   = tj.tracking_data?.shipment_track_activities ?? []
    const lastAct = acts.length > 0 ? acts[acts.length-1] : null
    const city   = lastAct?.location || order?.customer_city || order?.billing_city || order?.customer_state || 'N/A'
    const rawTime = acts[0]?.date || order?.order_date || ''

    // order_total / payment_method may be in different places now
    const orderTotal   = order?.order_total
                      || tj?.order_total
                      || pp?.orderTotal
                      || pp?.order?.order_total
    const paymentMethod = order?.payment_method
                       || tj?.payment_method
                       || pp?.paymentMethod
                       || pp?.order?.payment_method

    const slug = tj.company?.slug || pp?.slug || pp?.companySlug || ''
    const orderDate = order?.order_date || pp?.orderDate || 'N/A'
    const pincode   = order?.customer_pincode || pp?.pincode || 'N/A'
    const statusText = tj.shipment_status_text || pp?.shipmentStatus || 'N/A'

    if (!orderDate || orderDate === 'N/A') return null

    return {
      orderId:     originalId,
      slug,
      companyName: tj.company?.name || pp?.companyName || '',
      orderDate,
      orderTime:   rawTime.length >= 16 ? rawTime.slice(11,16) : 'N/A',
      dateYMD:     toYMD(orderDate),
      value:       orderTotal ? `Rs.${parseFloat(orderTotal).toFixed(2)}` : 'N/A',
      valueNum:    parseFloat(orderTotal) || 0,
      payment:     paymentMethod || 'N/A',
      status:      statusText,
      pincode,
      location:    city,
    }
  } catch { return null }
}

async function fetchOneOrder(subdomain: string, orderId: string|number): Promise<any> {
  const id = String(orderId)
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

  // ── Try 1: JSON API (/pocx/) ─────────────────────────
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
    if (res.ok) {
      const text = await res.text()
      if (text && !text.startsWith('<')) {
        const json = JSON.parse(text)
        const tj = json?.tracking_json
        // Only use if it has actual order data (not just {"rider_customer_data_ds":[]})
        if (tj?.order?.order_id) {
          const parsed = parseFromTJ(tj, orderId)
          if (parsed) return parsed
        }
      }
    }
    if (res.status === 429 || res.status === 403 || res.status === 503) return 'rl'
  } catch {}

  // ── Try 2: Page HTML → __NEXT_DATA__ ────────────────
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
    const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/)
    if (m) {
      const nd = JSON.parse(m[1])
      const parsed = parseFromNextData(nd, orderId)
      if (parsed) return parsed
    }
  } catch {}

  return null
}

export async function POST(req: NextRequest) {
  const { subdomain, ids } = await req.json() as { subdomain: string; ids: Array<string|number> }
  const results = await Promise.all(ids.map(id => fetchOneOrder(subdomain, id).catch(() => null)))
  return NextResponse.json({ results })
}
