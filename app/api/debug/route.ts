import { NextRequest, NextResponse } from 'next/server'
export const runtime = 'nodejs'

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

export async function POST(req: NextRequest) {
  const { subdomain, orderId } = await req.json()
  const id = String(orderId)
  const sub = subdomain || 'minnies'

  const res = await fetch(`https://${sub}.shiprocket.co/tracking/order/${id}`, {
    headers: { 'Accept': 'text/html', 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-IN' },
    signal: AbortSignal.timeout(15000),
  })
  const html = await res.text()
  const apidata = extractApidata(html)

  return NextResponse.json({
    pageLength: html.length,
    hasApidata: !!apidata,
    // Key fields that determine if proxy returns null
    order_date: apidata?.order?.order_date,
    system_order_id: apidata?.order?.system_order_id,
    shipment_status_text: apidata?.shipment_status_text,
    shipment_status: apidata?.shipment_status,
    show_pii: apidata?.show_pii,
    order_keys: apidata?.order ? Object.keys(apidata.order) : null,
    // Tracking activities (may have date even if order_date is empty)
    activities_count: apidata?.tracking_data?.shipment_track_activities?.length || 0,
    first_activity: apidata?.tracking_data?.shipment_track_activities?.[0],
    last_activity: apidata?.tracking_data?.shipment_track_activities?.slice(-1)[0],
    // Archived page detection
    hasArchivedBanner: html.includes('archived tracking') || html.includes('Verify as buyer'),
    // Full order object
    order_full: apidata?.order,
  })
}
