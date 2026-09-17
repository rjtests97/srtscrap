import { NextRequest, NextResponse } from 'next/server'
export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const { subdomain, orderId } = await req.json()
  const id = String(orderId)
  const sub = subdomain || 'minnies'

  const res = await fetch(`https://${sub}.shiprocket.co/tracking/order/${id}`, {
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept-Language': 'en-IN,en;q=0.9',
    },
    signal: AbortSignal.timeout(15000),
  })

  const rawText = await res.text()
  const contentType = res.headers.get('content-type') || ''
  const finalUrl = res.url

  // Try parse as JSON
  let asJson = null
  try { asJson = JSON.parse(rawText) } catch {}

  return NextResponse.json({
    httpStatus: res.status,
    finalUrl,           // shows if there was a redirect
    contentType,
    pageLength: rawText.length,
    // Show full content for small pages, first 3000 chars for large
    rawContent: rawText.length < 5000 ? rawText : rawText.slice(0, 3000) + '...[truncated]',
    asJson,             // parsed JSON if it's a JSON response
    // Key checks
    hasApidata: rawText.includes('var apidata = '),
    hasArchivedBanner: rawText.includes('archived tracking') || rawText.includes('Verify as buyer'),
    hasStatusKeyword: ['DELIVERED','IN TRANSIT','OUT FOR DELIVERY','PENDING','CANCELLED','RTO'].some(s => rawText.toUpperCase().includes(s)),
  })
}
