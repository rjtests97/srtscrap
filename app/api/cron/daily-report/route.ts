// Runs daily at 2:30 UTC = 8:00 AM IST
// 1. Scans yesterday's orders from Shiprocket automatically
// 2. Reads all historical runs from /tmp store
// 3. Sends morning Telegram report + CSV
//
// Required env vars:
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
//   BRAND_SUBDOMAIN, BRAND_NAME, BRAND_SLUG
//   BRAND_ANCHOR_ID, BRAND_ANCHOR_DATE  (e.g. "60476", "2025-12-31")
//   BRAND_ID_PREFIX (optional, e.g. "KYT" for alphanumeric IDs, leave blank for numeric)
// Optional:
//   CRON_SECRET (for manual trigger via ?secret=xxx)

import { NextRequest, NextResponse } from 'next/server'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'

export const runtime = 'nodejs'
export const maxDuration = 300  // 5 min — enough to scan 1 day of orders

// ── Config from env ───────────────────────────────────
const TG_TOKEN    = process.env.TELEGRAM_BOT_TOKEN || ''
const TG_CHAT     = process.env.TELEGRAM_CHAT_ID   || ''
const SUBDOMAIN   = process.env.BRAND_SUBDOMAIN    || ''
const BRAND_NAME  = process.env.BRAND_NAME         || 'Brand'
const BRAND_SLUG  = process.env.BRAND_SLUG         || SUBDOMAIN
const ANCHOR_ID   = parseInt(process.env.BRAND_ANCHOR_ID || '0')
const ANCHOR_DATE = process.env.BRAND_ANCHOR_DATE  || ''
const ID_PREFIX   = process.env.BRAND_ID_PREFIX    || ''
const SECRET      = process.env.CRON_SECRET        || ''

// ── Storage ───────────────────────────────────────────
const TMP_DIR = '/tmp/srtscraper'
const runsFile = () => join(TMP_DIR, `runs_${SUBDOMAIN}.json`)
const regFile  = () => join(TMP_DIR, `regpts_${SUBDOMAIN}.json`)

function ensureDir() { if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true }) }

function loadRuns(): any[] {
  try { return existsSync(runsFile()) ? JSON.parse(readFileSync(runsFile(),'utf-8')).runs || [] : [] } catch { return [] }
}
function saveRuns(runs: any[]) {
  ensureDir(); writeFileSync(runsFile(), JSON.stringify({ subdomain: SUBDOMAIN, runs, updatedAt: Date.now() }))
}
function loadRegPts(): Array<{date:string,id:number}> {
  try { return existsSync(regFile()) ? JSON.parse(readFileSync(regFile(),'utf-8')) : [] } catch { return [] }
}
function saveRegPts(pts: Array<{date:string,id:number}>) {
  ensureDir(); writeFileSync(regFile(), JSON.stringify(pts))
}

// ── Telegram ──────────────────────────────────────────
const tgSend = (method: string, body: any) =>
  fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  })

async function tgMsg(text: string) {
  await tgSend('sendMessage', { chat_id: TG_CHAT, text, parse_mode: 'HTML' })
}

async function tgDoc(filename: string, content: string, caption: string) {
  const form = new FormData()
  form.append('chat_id', TG_CHAT)
  form.append('caption', caption)
  form.append('document', new Blob([content], { type: 'text/csv' }), filename)
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendDocument`, { method: 'POST', body: form })
}

// ── Shiprocket proxy (same logic as /api/proxy) ───────
const MONTHS: Record<string,string> = {Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12'}

function toYMD(s: string) {
  if (!s) return null
  const m1 = s.match(/^(\d{1,2})\s+(\w{3})\s+(\d{4})/)
  if (m1) return `${m1[3]}-${MONTHS[m1[2]]||'00'}-${m1[1].padStart(2,'0')}`
  const m2 = s.match(/^(\d{4}-\d{2}-\d{2})/)
  return m2 ? m2[1] : null
}

function extractApidata(html: string) {
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

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function fetchOrder(id: number): Promise<any> {
  const strId = ID_PREFIX ? `${ID_PREFIX}${id}` : String(id)
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
  try {
    const res = await fetch(`https://${SUBDOMAIN}.shiprocket.co/tracking/order/${strId}`, {
      headers: { 'Accept': 'text/html', 'User-Agent': UA, 'Accept-Language': 'en-IN,en;q=0.9' },
      signal: AbortSignal.timeout(10000),
    })
    if (res.status === 429 || res.status === 403) return 'rl'
    if (!res.ok) return null
    const html = await res.text()
    const apidata = extractApidata(html)
    if (!apidata?.order?.order_date) return null
    const order = apidata.order
    const acts = apidata.tracking_data?.shipment_track_activities ?? []
    const lastAct = acts.length > 0 ? acts[acts.length-1] : null
    const city = lastAct?.location || order.customer_city || order.customer_state || 'N/A'
    const rawTime = acts[0]?.date || order.order_date || ''
    return {
      orderId:     strId,
      slug:        apidata.company?.slug || BRAND_SLUG,
      orderDate:   order.order_date,
      orderTime:   rawTime.length >= 16 ? rawTime.slice(11,16) : 'N/A',
      dateYMD:     toYMD(order.order_date),
      value:       order.order_total ? `Rs.${parseFloat(order.order_total).toFixed(2)}` : 'N/A',
      valueNum:    parseFloat(order.order_total) || 0,
      payment:     order.payment_method || 'N/A',
      status:      apidata.shipment_status_text || 'N/A',
      pincode:     order.customer_pincode || 'N/A',
      location:    city,
    }
  } catch { return null }
}

// ── Find ID bracket for a date ────────────────────────
async function walkToDate(
  refId: number, refDate: string, targetDate: string
): Promise<{ lo: number; hi: number }> {
  const forward = targetDate > refDate
  let lo = refId, hi = refId, lastId = refId, consNulls = 0

  for (let i = 1; i <= 300; i++) {
    const pid = forward ? refId + i * 500 : Math.max(1, refId - i * 500)
    const o = await fetchOrder(pid)
    if (o && o !== 'rl' && o.dateYMD) {
      lastId = parseInt(String(o.orderId).replace(/\D/g,'')) || pid
      consNulls = 0
      if (forward) {
        if (o.dateYMD >= targetDate) { hi = lastId; break }
        lo = lastId
        const daysLeft = (new Date(targetDate+'T00:00:00').getTime() - new Date(o.dateYMD+'T00:00:00').getTime()) / 86400000
        if (daysLeft <= 5) { hi = lastId + 3000; break }
      } else {
        if (o.dateYMD < targetDate) { lo = lastId; break }
        hi = lastId
      }
    } else if (o === null) {
      consNulls++
      if (forward && lo > refId && consNulls >= 4) { hi = lastId + 1500; break }
    }
    await sleep(80)
    if (!forward && pid <= 1) break
  }
  if (hi <= lo) hi = lo + 2000
  return { lo, hi }
}

// ── Scan one day of orders ────────────────────────────
async function scanDay(
  dateStr: string,
  anchorId: number,
  anchorDate: string,
  regPts: Array<{date:string,id:number}>
): Promise<{ orders: any[]; newRegPts: Array<{date:string,id:number}> }> {
  // Find best reference point
  const pts = [{ date: anchorDate, id: anchorId }, ...regPts]
    .filter(p => p.date && p.id > 0)
    .sort((a, b) => a.date.localeCompare(b.date))

  const closest = (d: string) => pts.reduce((best, p) =>
    Math.abs(new Date(p.date+'T00:00:00').getTime() - new Date(d+'T00:00:00').getTime()) <
    Math.abs(new Date(best.date+'T00:00:00').getTime() - new Date(d+'T00:00:00').getTime()) ? p : best
  , pts[0])

  const ref = closest(dateStr)

  // Find bracket for start of day
  const startBracket = await walkToDate(ref.id, ref.date, dateStr)
  const scanStart = Math.max(1, startBracket.lo - 50)

  // Find bracket for end of day (next day)
  const nextDay = new Date(new Date(dateStr+'T00:00:00').getTime() + 86400000).toISOString().split('T')[0]
  const refEnd = startBracket.lo > closest(nextDay).id ? { id: startBracket.lo, date: dateStr } : closest(nextDay)
  const endBracket = await walkToDate(refEnd.id, refEnd.date, nextDay)
  const scanEnd = endBracket.hi + 50

  console.log(`Scanning ${dateStr}: #${scanStart} to #${scanEnd} (${scanEnd - scanStart + 1} IDs)`)

  // Burst scan
  const orders: any[] = []
  const BURST = 50, REST = 2000, CONCURRENCY = 3
  let rlStreak = 0

  for (let base = scanStart; base <= scanEnd; ) {
    const burstEnd = Math.min(base + BURST - 1, scanEnd)

    for (let b = base; b <= burstEnd; b += CONCURRENCY) {
      const ids = Array.from({ length: Math.min(CONCURRENCY, burstEnd - b + 1) }, (_, i) => b + i)
      const results = await Promise.all(ids.map(id => fetchOrder(id)))

      for (let i = 0; i < ids.length; i++) {
        const o = results[i]
        if (o === 'rl') { rlStreak++; continue }
        rlStreak = Math.max(0, rlStreak - 1)
        if (o && o.dateYMD === dateStr) orders.push(o)
      }
      await sleep(rlStreak > 0 ? Math.min(rlStreak * 3000, 15000) : 150)
    }

    base = burstEnd + 1
    if (base <= scanEnd) await sleep(REST)
  }

  // Update regression points from found orders
  const byDate: Record<string, { min: number; max: number }> = {}
  orders.forEach(o => {
    if (!o.dateYMD) return
    const n = parseInt(String(o.orderId).replace(/\D/g,'')) || 0
    if (!byDate[o.dateYMD]) byDate[o.dateYMD] = { min: n, max: n }
    else { byDate[o.dateYMD].min = Math.min(byDate[o.dateYMD].min, n); byDate[o.dateYMD].max = Math.max(byDate[o.dateYMD].max, n) }
  })
  const newPts = Object.entries(byDate).map(([date, { min, max }]) => ({ date, id: Math.round((min+max)/2) }))
  const merged = Object.values(Object.fromEntries([...regPts, ...newPts].map(p => [p.date, p])))
    .sort((a: any, b: any) => a.date.localeCompare(b.date)) as Array<{date:string,id:number}>

  return { orders, newRegPts: merged.slice(-30) }
}

// ── Report formatting ─────────────────────────────────
const fmt = (n: number) => n >= 100000 ? `₹${(n/100000).toFixed(1)}L` : n >= 1000 ? `₹${(n/1000).toFixed(1)}k` : `₹${n}`
const fmtDate = (d: string) => new Date(d+'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })

function calcStats(orders: any[]) {
  const rev = orders.reduce((s, o) => s + (o.valueNum || 0), 0)
  const cod = orders.filter(o => (o.payment||'').toUpperCase() === 'COD').length
  return { count: orders.length, rev: Math.round(rev), cod, prepaid: orders.length - cod, avg: orders.length ? Math.round(rev/orders.length) : 0 }
}

// ── Main handler ──────────────────────────────────────
export async function GET(req: NextRequest) {
  const isVercelCron = req.headers.get('x-vercel-cron') === '1'
  const secret = req.nextUrl.searchParams.get('secret') || req.headers.get('authorization') || ''
  if (!isVercelCron && SECRET && secret !== SECRET)
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  if (!TG_TOKEN || !TG_CHAT || !SUBDOMAIN || !ANCHOR_ID || !ANCHOR_DATE)
    return NextResponse.json({ error: 'Missing env vars', required: 'TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, BRAND_SUBDOMAIN, BRAND_NAME, BRAND_ANCHOR_ID, BRAND_ANCHOR_DATE' })

  // Yesterday in IST
  const now    = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }))
  const today  = now.toISOString().split('T')[0]
  const yest   = new Date(now.getTime() - 86400000).toISOString().split('T')[0]
  const dow    = now.getDay() || 7
  const wStart = new Date(now.getTime() - (dow-1)*86400000).toISOString().split('T')[0]
  const mStart = today.slice(0,7) + '-01'

  await tgMsg(`🔍 Scanning ${BRAND_NAME} orders for ${fmtDate(yest)}...`)

  try {
    // Load existing data
    const existingRuns = loadRuns()
    let regPts = loadRegPts()

    // Also pull regPts from stored runs if we have them
    if (regPts.length === 0 && existingRuns.length > 0) {
      const allOrders = existingRuns.flatMap(r => r.orders || [])
      const byDate: Record<string,{min:number,max:number}> = {}
      allOrders.forEach((o: any) => {
        if (!o.dateYMD) return
        const n = parseInt(String(o.orderId).replace(/\D/g,'')) || 0
        if (!byDate[o.dateYMD]) byDate[o.dateYMD]={min:n,max:n}
        else { byDate[o.dateYMD].min=Math.min(byDate[o.dateYMD].min,n); byDate[o.dateYMD].max=Math.max(byDate[o.dateYMD].max,n) }
      })
      regPts = Object.entries(byDate).map(([date,{min,max}])=>({date,id:Math.round((min+max)/2)}))
        .sort((a,b) => a.date.localeCompare(b.date)).slice(-30)
    }

    // Scan yesterday
    const { orders: yestOrders, newRegPts } = await scanDay(yest, ANCHOR_ID, ANCHOR_DATE, regPts)
    saveRegPts(newRegPts)

    // Save this run
    const newRun = {
      runId: Date.now().toString(),
      dateRange: yest,
      found: yestOrders.length,
      orders: yestOrders,
      createdAt: now.toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' })
    }
    const updatedRuns = [newRun, ...existingRuns].slice(0, 60)
    saveRuns(updatedRuns)

    // All orders for WTD/MTD calculation
    const allOrders = updatedRuns.flatMap(r => r.orders || [])
    const wtdOrders = allOrders.filter((o:any) => o.dateYMD >= wStart && o.dateYMD <= today)
    const mtdOrders = allOrders.filter((o:any) => o.dateYMD >= mStart && o.dateYMD <= today)

    const y = calcStats(yestOrders)
    const w = calcStats(wtdOrders)
    const m = calcStats(mtdOrders)

    const cityMap: Record<string,number> = {}
    yestOrders.forEach((o:any) => { const c=o.location; if(c&&c!=='N/A') cityMap[c]=(cityMap[c]||0)+1 })
    const topCities = Object.entries(cityMap).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([c,n])=>`${c} (${n})`).join(' · ')

    const yLine = y.count > 0
      ? [`📦 ${y.count} orders | ${fmt(y.rev)} | Avg ₹${y.avg}`,
         `💳 COD: ${y.cod} (${y.count?Math.round(y.cod/y.count*100):0}%) · Prepaid: ${y.prepaid}`,
         topCities ? `📍 ${topCities}` : ''
        ].filter(Boolean).join('\n')
      : 'No orders found for yesterday'

    const report = [
      `🌅 <b>Morning Report</b> — ${BRAND_NAME}`,
      `📅 <b>Yesterday</b> (${fmtDate(yest)})`,
      yLine,
      '',
      `📊 <b>Week to Date</b> (from ${fmtDate(wStart)}): <b>${w.count}</b> orders · ${fmt(w.rev)}`,
      `📈 <b>Month to Date</b>: <b>${m.count}</b> orders · ${fmt(m.rev)}`,
      '',
      `<i>Auto-scanned · Shiprocket Order Scrapper</i>`
    ].join('\n')

    await tgMsg(report)

    // Attach CSV
    if (yestOrders.length > 0) {
      const csv = 'Order ID,Date,Time,Value,Payment,Status,Location,Pincode\n' +
        yestOrders.map((o:any) =>
          `${o.orderId},${o.orderDate},${o.orderTime},${o.value},${o.payment},${o.status},${o.location},${o.pincode}`
        ).join('\n')
      await tgDoc(`${BRAND_NAME.replace(/\s+/g,'_')}_${yest}.csv`, csv, `Yesterday's ${y.count} orders — ${BRAND_NAME}`)
    }

    return NextResponse.json({ ok: true, scanned: yest, found: y.count, wtd: w.count, mtd: m.count })

  } catch (err: any) {
    await tgMsg(`⚠️ Auto-scan failed for ${BRAND_NAME}\nError: ${err.message}`)
    return NextResponse.json({ ok: false, error: err.message })
  }
}
