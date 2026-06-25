import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const maxDuration = 60

// ── Config (Vercel env vars) ──────────────────────────────────────────────
const SUBDOMAIN   = process.env.BRAND_SUBDOMAIN    || ''
const BRAND_NAME  = process.env.BRAND_NAME         || 'Brand'
const ANCHOR_ID   = parseInt(process.env.BRAND_ANCHOR_ID || '0')
const ANCHOR_DATE = process.env.BRAND_ANCHOR_DATE  || ''
const ID_PREFIX   = process.env.BRAND_ID_PREFIX    || ''
const SHEETS_URL  = process.env.SHEETS_URL         || ''   // Google Apps Script web-app URL
const TG_TOKEN    = process.env.TELEGRAM_BOT_TOKEN || ''   // optional
const TG_CHAT     = process.env.TELEGRAM_CHAT_ID   || ''   // optional
const SECRET      = process.env.CRON_SECRET        || ''

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const toId = (n: number) => (ID_PREFIX ? `${ID_PREFIX}${n}` : n)
const numId = (v: any) => parseInt(String(v).replace(/\D/g, '')) || 0
const fmtDate = (d: string) =>
  new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })

async function callProxy(origin: string, ids: Array<number>): Promise<any[]> {
  try {
    const res = await fetch(`${origin}/api/proxy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subdomain: SUBDOMAIN, ids: ids.map(toId) }),
      signal: AbortSignal.timeout(20000),
    })
    if (!res.ok) return ids.map(() => 'rl')
    const { results } = await res.json()
    return results
  } catch { return ids.map(() => 'rl') }
}

// Walk in 500-ID steps from the anchor to bracket a target date.
async function walk(origin: string, refId: number, refDate: string, target: string) {
  const fwd = target > refDate
  let lo = refId, hi = refId
  for (let i = 1; i <= 80 && !(fwd ? hi > refId : lo < refId); i++) {
    const pid = fwd ? refId + i * 500 : Math.max(1, refId - i * 500)
    const o = (await callProxy(origin, [pid]))[0]
    if (o && o !== 'rl' && o.dateYMD) {
      const n = numId(o.orderId) || pid
      if (fwd) {
        if (o.dateYMD >= target) { hi = n; break }
        lo = n
        const dl = (new Date(target + 'T00:00:00').getTime() - new Date(o.dateYMD + 'T00:00:00').getTime()) / 86400000
        if (dl <= 5) { hi = n + 2500; break }
      } else {
        if (o.dateYMD < target) { lo = n; break }
        hi = n
      }
    } else if (o === null && fwd && lo > refId) { hi = lo + 1200; break }
    if (!fwd && pid <= 1) break
    await sleep(120)
  }
  if (hi <= lo) hi = lo + 1500
  return { lo, hi }
}

// Push rows to the Google Sheet via the Apps Script web app (append/upsert).
async function pushToSheet(orders: any[]): Promise<{ ok: boolean; added?: number; error?: string }> {
  if (!SHEETS_URL) return { ok: false, error: 'SHEETS_URL not set' }
  try {
    const res = await fetch(SHEETS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },   // text/plain avoids Apps Script CORS preflight
      body: JSON.stringify({ orders, mode: 'append', brand: BRAND_NAME }),
      signal: AbortSignal.timeout(30000),
    })
    const d = await res.json().catch(() => ({}))
    return { ok: !!d.ok, added: d.added }
  } catch (e: any) { return { ok: false, error: String(e?.message || e) } }
}

const tg = async (text: string) => {
  if (!TG_TOKEN || !TG_CHAT) return
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML' }),
    })
  } catch {}
}

export async function GET(req: NextRequest) {
  const isVercelCron = req.headers.get('x-vercel-cron') === '1'
  const secret = req.nextUrl.searchParams.get('secret') || ''
  if (!isVercelCron && SECRET && secret !== SECRET)
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const missing = ['BRAND_SUBDOMAIN', 'BRAND_ANCHOR_ID', 'BRAND_ANCHOR_DATE', 'SHEETS_URL']
    .filter(k => !process.env[k])
  if (missing.length) {
    await tg(`⚠️ <b>Cron failed</b> — missing env vars: ${missing.join(', ')}`)
    return NextResponse.json({ error: 'missing env vars', missing }, { status: 400 })
  }

  // Target date: ?date=YYYY-MM-DD or yesterday in IST.
  const q = req.nextUrl.searchParams
  const nowIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }))
  const yest = new Date(nowIST.getTime() - 86400000).toISOString().split('T')[0]
  const dateStr = q.get('date') || yest
  const origin = `https://${req.headers.get('host')}`
  const nextD = new Date(new Date(dateStr + 'T00:00:00').getTime() + 86400000).toISOString().split('T')[0]

  // Stateless chunking: a day can hold 500+ orders, which won't fit one 60s
  // run. We scan up to CHUNK IDs per invocation and pass the continuation
  // (from / scanEnd / running totals) in the URL — no /tmp, so it's reliable
  // across serverless instances. The Sheet upsert dedupes, so an accidental
  // re-run is harmless.
  const CHUNK = 300, CONC = 10
  const carriedFrom = parseInt(q.get('from') || '0')
  const carriedEnd = parseInt(q.get('scanEnd') || '0')
  let priorFound = parseInt(q.get('found') || '0')
  let priorScanned = parseInt(q.get('scanned') || '0')

  let scanStart: number, scanEnd: number
  if (carriedFrom && carriedEnd) {
    scanStart = carriedFrom; scanEnd = carriedEnd          // continuation chunk
  } else {
    // First invocation — bracket the day's ID range from the anchor.
    const fromB = await walk(origin, ANCHOR_ID, ANCHOR_DATE, dateStr)
    const refE = fromB.lo > ANCHOR_ID ? { id: fromB.lo, date: dateStr } : { id: ANCHOR_ID, date: ANCHOR_DATE }
    const toB = await walk(origin, refE.id, refE.date, nextD)
    scanStart = Math.max(1, fromB.lo - 30)
    scanEnd = toB.hi + 30
  }

  const chunkEnd = Math.min(scanStart + CHUNK - 1, scanEnd)
  const collected: any[] = []
  let scanned = 0
  for (let base = scanStart; base <= chunkEnd; base += CONC) {
    const ids = Array.from({ length: Math.min(CONC, chunkEnd - base + 1) }, (_, i) => base + i)
    const results = await callProxy(origin, ids)
    results.forEach((o: any) => {
      scanned++
      if (o && o !== 'rl' && o.dateYMD === dateStr) collected.push(o)
    })
    await sleep(40)
  }

  // Push this chunk's orders to the Sheet right away (upsert dedupes).
  const pushed = await pushToSheet(collected)
  const totalFound = priorFound + collected.length
  const totalScanned = priorScanned + scanned
  const done = chunkEnd >= scanEnd

  if (!done) {
    // Hand off the next chunk to a fresh invocation (stateless).
    const next = new URL(`${origin}/api/cron/scan`)
    next.searchParams.set('date', dateStr)
    next.searchParams.set('from', String(chunkEnd + 1))
    next.searchParams.set('scanEnd', String(scanEnd))
    next.searchParams.set('found', String(totalFound))
    next.searchParams.set('scanned', String(totalScanned))
    if (SECRET) next.searchParams.set('secret', SECRET)
    fetch(next.toString()).catch(() => {})
    return NextResponse.json({
      ok: true, done: false, date: dateStr,
      chunk: `${scanStart}-${chunkEnd}`, found: totalFound, remaining: scanEnd - chunkEnd,
    })
  }

  // Final chunk done — send the optional Telegram summary with the day total.
  if (TG_TOKEN && TG_CHAT) {
    await tg([
      `✅ <b>${BRAND_NAME}</b> — ${fmtDate(dateStr)}`,
      `📦 <b>${totalFound}</b> orders` + (pushed.ok ? ` → Google Sheet` : ` (⚠️ last sheet push failed)`),
    ].join('\n'))
  }

  return NextResponse.json({
    ok: true, done: true, date: dateStr,
    range: `${scanStart}-${scanEnd}`, scanned: totalScanned, found: totalFound, sheet: pushed,
  })
}
