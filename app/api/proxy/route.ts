// The ONLY server-side code needed.
// Browser can't call shiprocket.co directly (CORS). This proxies the request.
// Each call: fetch up to 10 orders, return results. Max ~2s. Well within limits.

import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const { subdomain, ids } = await req.json() as { subdomain: string; ids: number[] }

  const results = await Promise.all(
    ids.map(async (id) => {
      try {
        const res = await fetch(
          `https://${subdomain}.shiprocket.co/pocx/tracking/order/${id}`,
          {
            headers: {
              'Accept': 'application/json',
              'Referer': `https://${subdomain}.shiprocket.co/`,
              'X-Requested-With': 'XMLHttpRequest',
            },
            signal: AbortSignal.timeout(8000),
          }
        )
        if (res.status === 429 || res.status === 403 || res.status === 503) return 'rl'
        if (!res.ok) return null
        const text = await res.text()
        if (!text || text.includes('<html') || text.includes('<!DOCTYPE')) return 'rl'
        const json = JSON.parse(text)
        const tj = json?.tracking_json
        if (!tj?.order?.order_id) return null
        const order = tj.order
        const acts = tj.tracking_data?.shipment_track_activities ?? []
        const lastAct = acts.length > 0 ? acts[acts.length - 1] : null
        const city = lastAct?.location || order.customer_city || order.billing_city || order.customer_state || 'N/A'
        const rawTime = acts[0]?.date || order.order_date || ''
        const MONTHS: Record<string,string> = {Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12'}
        const toYMD = (s: string) => {
          const m1 = s?.match(/^(\d{1,2})\s+(\w{3})\s+(\d{4})/)
          if (m1) return `${m1[3]}-${MONTHS[m1[2]]||'00'}-${m1[1].padStart(2,'0')}`
          const m2 = s?.match(/^(\d{4}-\d{2}-\d{2})/)
          return m2 ? m2[1] : null
        }
        return {
          orderId: id,
          slug: tj.company?.slug || '',
          companyName: tj.company?.name || '',
          orderDate: order.order_date ?? 'N/A',
          orderTime: rawTime.length >= 16 ? rawTime.slice(11,16) : 'N/A',
          dateYMD: toYMD(order.order_date || ''),
          value: order.order_total ? `Rs.${parseFloat(order.order_total).toFixed(2)}` : 'N/A',
          valueNum: parseFloat(order.order_total) || 0,
          payment: order.payment_method ?? 'N/A',
          status: tj.shipment_status_text ?? 'N/A',
          pincode: order.customer_pincode ?? 'N/A',
          location: city,
        }
      } catch {
        return null
      }
    })
  )

  return NextResponse.json({ results })
}
