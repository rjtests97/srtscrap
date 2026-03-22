export interface OrderResult {
  orderId: number; slug: string; companyName: string
  orderDate: string; orderTime: string; dateYMD: string | null
  value: string; valueNum: number; payment: string
  status: string; pincode: string; location: string
}

const MONTHS: Record<string,string> = {
  Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',
  Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12'
}

export function toYMD(str: string): string | null {
  if (!str || str==='N/A') return null
  const m1 = str.match(/^(\d{1,2})\s+(\w{3})\s+(\d{4})/)
  if (m1) return `${m1[3]}-${MONTHS[m1[2]]||'00'}-${m1[1].padStart(2,'0')}`
  const m2 = str.match(/^(\d{4}-\d{2}-\d{2})/)
  return m2 ? m2[1] : null
}

export function parseTJ(tj: any, id: number): OrderResult | null {
  if (!tj?.order?.order_id) return null
  const order = tj.order
  const acts  = tj.tracking_data?.shipment_track_activities ?? []
  const rawTime = acts[0]?.date || order.order_date || ''
  const lastAct = acts.length > 0 ? acts[acts.length-1] : null
  const city = lastAct?.location || order.customer_city || order.billing_city || order.customer_state || 'N/A'
  return {
    orderId: id, slug: tj.company?.slug||'', companyName: tj.company?.name||'',
    orderDate: order.order_date??'N/A',
    orderTime: rawTime.length>=16 ? rawTime.slice(11,16) : 'N/A',
    dateYMD: toYMD(order.order_date),
    value: order.order_total ? `Rs.${parseFloat(order.order_total).toFixed(2)}` : 'N/A',
    valueNum: parseFloat(order.order_total)||0,
    payment: order.payment_method??'N/A', status: tj.shipment_status_text??'N/A',
    pincode: order.customer_pincode??'N/A', location: city,
  }
}

export async function fetchOrder(subdomain: string, id: number): Promise<OrderResult|null|'rl'> {
  try {
    const res = await fetch(
      `https://${subdomain}.shiprocket.co/pocx/tracking/order/${id}`,
      { headers: {
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-IN,en;q=0.9',
          'Referer': `https://${subdomain}.shiprocket.co/`,
          'X-Requested-With': 'XMLHttpRequest',
        },
        signal: AbortSignal.timeout(8000),
        cache: 'no-store',
      }
    )
    if ([429,403,503,502,504].includes(res.status)) return 'rl'
    if (!res.ok) return null
    const text = await res.text()
    if (!text || text.length < 5) return 'rl'
    if (text.includes('<html') || text.includes('<!DOCTYPE')) return 'rl'
    let json: any
    try { json = JSON.parse(text) } catch { return 'rl' }
    const tj = json?.tracking_json
    if (!tj) {
      const keys = Object.keys(json||{})
      return (!keys.some(k=>['error','message','status'].includes(k.toLowerCase())) && keys.length<=3) ? 'rl' : null
    }
    return parseTJ(tj, id)
  } catch(e: any) {
    if (e.name==='TimeoutError'||e.name==='AbortError') return 'rl'
    return null
  }
}
