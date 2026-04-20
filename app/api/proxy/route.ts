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

// Extract var apidata = {...} from page HTML using brace-counting
function extractApidata(html: string): any {
  const marker = 'var apidata = '
  const idx = html.indexOf(marker)
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

function parseApidata(apidata: any, originalId: string|number): any {
  if (!apidata) return null
  const order = apidata.order
  const company = apidata.company
  const slug = company?.slug || ''
  const orderDate = order?.order_date || ''
  if (!orderDate) return null

  const acts = apidata.tracking_data?.shipment_track_activities ?? []
  const lastAct = acts.length > 0 ? acts[acts.length-1] : null
  const city = lastAct?.location || order?.customer_city || order?.billing_city || order?.customer_state || 'N/A'
  const rawTime = acts[0]?.date || orderDate || ''

  // order_total and payment_method are hidden when show_pii=0
  // They no longer exist in the public tracking page response
  const orderTotal = order?.order_total || null
  const paymentMethod = order?.payment_method || null

  return {
    orderId:     originalId,
    slug,
    companyName: company?.name || '',
    orderDate:   orderDate,
    orderTime:   rawTime.length >= 16 ? rawTime.slice(11,16) : 'N/A',
    dateYMD:     toYMD(orderDate),
    value:       orderTotal ? `Rs.${parseFloat(orderTotal).toFixed(2)}` : 'N/A',
    valueNum:    parseFloat(orderTotal||'0') || 0,
    payment:     paymentMethod || 'N/A',
    status:      apidata.shipment_status_text || 'N/A',
    pincode:     order?.customer_pincode || 'N/A',
    location:    city,
  }
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

async function fetchOneOrder(subdomain: string, orderId: string|number): Promise<any> {
  const id = String(orderId)

  // Primary: fetch the HTML tracking page and extract apidata
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
    const apidata = extractApidata(html)
    if (apidata?.order?.order_date) {
      return parseApidata(apidata, orderId)
    }
  } catch {}

  // Fallback: old /pocx/ JSON API (may still work for some brands)
  try {
    const res = await fetch(`https://${subdomain}.shiprocket.co/pocx/tracking/order/${id}`, {
      headers: {
        'Accept': 'application/json',
        'Referer': `https://${subdomain}.shiprocket.co/`,
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': UA,
      },
      signal: AbortSignal.timeout(8000),
    })
    if (res.status === 429 || res.status === 403 || res.status === 503) return 'rl'
    if (res.ok) {
      const text = await res.text()
      if (text && !text.startsWith('<')) {
        const json = JSON.parse(text)
        const tj = json?.tracking_json
        if (tj?.order?.order_date) {
          const order = tj.order
          const acts = tj.tracking_data?.shipment_track_activities ?? []
          const lastAct = acts.length > 0 ? acts[acts.length-1] : null
          const city = lastAct?.location || order.customer_city || order.billing_city || 'N/A'
          const rawTime = acts[0]?.date || order.order_date || ''
          return {
            orderId:     orderId,
            slug:        tj.company?.slug || '',
            companyName: tj.company?.name || '',
            orderDate:   order.order_date,
            orderTime:   rawTime.length >= 16 ? rawTime.slice(11,16) : 'N/A',
            dateYMD:     toYMD(order.order_date),
            value:       order.order_total ? `Rs.${parseFloat(order.order_total).toFixed(2)}` : 'N/A',
            valueNum:    parseFloat(order.order_total) || 0,
            payment:     order.payment_method || 'N/A',
            status:      tj.shipment_status_text || 'N/A',
            pincode:     order.customer_pincode || 'N/A',
            location:    city,
          }
        }
      }
    }
  } catch {}

  return null
}

export async function POST(req: NextRequest) {
  const { subdomain, ids } = await req.json() as { subdomain: string; ids: Array<string|number> }
  // Fetch sequentially to avoid overwhelming Shiprocket (page scraping is heavier)
  const results: any[] = []
  for (const id of ids) {
    if (results.filter(r => r === 'rl').length > ids.length / 2) {
      // More than half rate limited — return all remaining as rl
      results.push(...ids.slice(results.length).map(() => 'rl'))
      break
    }
    results.push(await fetchOneOrder(subdomain, id).catch(() => null))
  }
  return NextResponse.json({ results })
}
