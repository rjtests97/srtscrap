import { NextRequest, NextResponse } from 'next/server'
export const runtime = 'nodejs'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

export async function POST(req: NextRequest) {
  const { subdomain, orderId, companyId } = await req.json()
  const id = String(orderId)
  const sub = subdomain || 'minnies'
  const cid = companyId || 4191871

  const lookupUrl = `https://apiv2.shiprocket.co/tracking-form-check?track_id=${id}&track_type=order_id&company_id=${cid}`
  const lookupRes = await fetch(lookupUrl, {
    headers: { 'Accept': 'application/json', 'User-Agent': UA, 'Referer': `https://${sub}.shiprocket.co/`, 'Origin': `https://${sub}.shiprocket.co` },
    signal: AbortSignal.timeout(10000),
  })
  const lookupData = await lookupRes.json()
  const trackingUrl = lookupData?.url
  if (!trackingUrl) return NextResponse.json({ error: 'no tracking url' })

  const awbRes = await fetch(trackingUrl, {
    headers: { 'Accept': 'text/html', 'User-Agent': UA, 'Accept-Language': 'en-IN,en;q=0.9' },
    signal: AbortSignal.timeout(15000),
  })
  const html = await awbRes.text()

  // Extract just the body content (skip <style> block)
  const bodyStart = html.indexOf('<body')
  const bodyHtml = bodyStart >= 0 ? html.slice(bodyStart) : html

  // Try extracting specific data points with regex
  const statusMatch = bodyHtml.match(/status-value[^"]*"[^>]*>\s*([^<]+)/i)
  const dateMatch = bodyHtml.match(/delivered-date[^"]*"[^>]*>\s*([^<]+)/i)
  const detailRows = [...bodyHtml.matchAll(/detail-label[^>]*>([^<]+)<\/[^>]+>\s*<[^>]+detail-value[^>]*>([^<]+)/gi)]
    .map(m => ({ label: m[1].trim(), value: m[2].trim() }))
  const courierMatch = bodyHtml.match(/courier-name[^>]*>([^<]+)/i)
  const trackingIdMatch = bodyHtml.match(/tracking-id-value[^>]*>([^<]+)/i)

  return NextResponse.json({
    status: awbRes.status,
    bodyLength: bodyHtml.length,
    extracted: {
      status: statusMatch?.[1]?.trim(),
      deliveredDate: dateMatch?.[1]?.trim(),
      detailRows,
      courier: courierMatch?.[1]?.trim(),
      trackingId: trackingIdMatch?.[1]?.trim(),
    },
    bodyPreview: bodyHtml.slice(0, 4000),
  })
}
