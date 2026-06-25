// Same-origin proxy for the browser → Google Apps Script web app.
// Apps Script returns no CORS headers and 302-redirects its response, so a
// direct browser fetch fails with "Failed to fetch" even when the write
// succeeds. Forwarding server-side (Node follows the redirect, no CORS) fixes
// both the error and the inability to read the result.
import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  try {
    const { url, orders, mode, brand } = await req.json()
    if (!url || !/^https:\/\/script\.google\.com\//.test(String(url)))
      return NextResponse.json({ ok: false, error: 'Invalid Apps Script URL' }, { status: 400 })

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },   // text/plain avoids Apps Script preflight
      body: JSON.stringify({ orders: orders || [], mode: mode || 'append', brand: brand || '' }),
      signal: AbortSignal.timeout(30000),
    })
    const text = await res.text()
    try { return NextResponse.json(JSON.parse(text)) }
    catch { return NextResponse.json({ ok: false, error: 'Non-JSON response from Apps Script (check the deployment is "Anyone" access)', raw: text.slice(0, 200) }) }
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 })
  }
}
