import { NextRequest, NextResponse } from 'next/server'
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

export const runtime = 'nodejs'
export const maxDuration = 60

const TG_TOKEN   = process.env.TELEGRAM_BOT_TOKEN || ''
const TG_CHAT    = process.env.TELEGRAM_CHAT_ID   || ''
const SUBDOMAIN  = process.env.BRAND_SUBDOMAIN    || ''
const BRAND_NAME = process.env.BRAND_NAME         || 'Brand'
const SECRET     = process.env.CRON_SECRET        || ''

const TMP = '/tmp/srtscraper'

const tgMsg = async (text: string) => {
  if (!TG_TOKEN || !TG_CHAT) return
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML' })
  })
}

const tgDoc = async (filename: string, csv: string, caption: string) => {
  const form = new FormData()
  form.append('chat_id', TG_CHAT)
  form.append('caption', caption)
  form.append('document', new Blob([csv], { type: 'text/csv' }), filename)
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendDocument`, { method: 'POST', body: form })
}

function loadAllOrders(): any[] {
  try {
    const f = join(TMP, `runs_${SUBDOMAIN}.json`)
    if (!existsSync(f)) return []
    const data = JSON.parse(readFileSync(f, 'utf-8'))
    return (data.runs || []).flatMap((r: any) => r.orders || [])
  } catch { return [] }
}

const fmtDate = (d: string) =>
  new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })

export async function GET(req: NextRequest) {
  const isVercelCron = req.headers.get('x-vercel-cron') === '1'
  const secret = req.nextUrl.searchParams.get('secret') || ''
  if (!isVercelCron && SECRET && secret !== SECRET)
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const missing = ['TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID','BRAND_SUBDOMAIN','BRAND_ANCHOR_ID','BRAND_ANCHOR_DATE']
    .filter(k => !process.env[k])
  if (missing.length) {
    await tgMsg(`⚠️ <b>Cron failed</b> — missing env vars:\n${missing.join(', ')}`)
    return NextResponse.json({ error: 'missing env vars', missing })
  }

  // IST date calculations
  const now    = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }))
  const today  = now.toISOString().split('T')[0]
  const yest   = new Date(now.getTime() - 86400000).toISOString().split('T')[0]
  const dow    = now.getDay() === 0 ? 7 : now.getDay()
  const wStart = new Date(now.getTime() - (dow - 1) * 86400000).toISOString().split('T')[0]
  const mStart = today.slice(0, 7) + '-01'
  const origin = `https://${req.headers.get('host')}`

  // Load stored orders for WTD/MTD context
  const stored = loadAllOrders()
  const wtdO   = stored.filter((o: any) => o.dateYMD >= wStart && o.dateYMD <= today)
  const mtdO   = stored.filter((o: any) => o.dateYMD >= mStart && o.dateYMD <= today)
  const yestStored = stored.filter((o: any) => o.dateYMD === yest)

  // Build and send report immediately — don't wait for scan
  const cityMap: Record<string, number> = {}
  yestStored.forEach((o: any) => {
    const c = o.location; if (c && c !== 'N/A') cityMap[c] = (cityMap[c] || 0) + 1
  })
  const topCities = Object.entries(cityMap).sort((a, b) => b[1] - a[1])
    .slice(0, 3).map(([c, n]) => `${c} (${n})`).join(' · ')

  const yestLine = yestStored.length > 0
    ? [`📦 ${yestStored.length} orders`, topCities ? `📍 ${topCities}` : ''].filter(Boolean).join('\n')
    : `📦 Scanning... report will follow shortly`

  const msg = [
    `🌅 <b>Morning Report</b> — ${BRAND_NAME}`,
    `📅 <b>Yesterday</b> (${fmtDate(yest)})`,
    yestLine, '',
    `📊 <b>Week to Date</b> (from ${fmtDate(wStart)}): <b>${wtdO.length}</b> orders`,
    `📈 <b>Month to Date</b>: <b>${mtdO.length}</b> orders`,
    '', `<i>srtscrap.vercel.app</i>`
  ].join('\n')

  await tgMsg(msg)

  if (yestStored.length > 0) {
    const csv = 'Order ID,Date,Time,Status,Location,Pincode,Source\n' +
      yestStored.map((o: any) => `${o.orderId},${o.orderDate},${o.orderTime},${o.status},${o.location},${o.pincode},fresh`).join('\n')
    await tgDoc(`${BRAND_NAME.replace(/\s+/g, '_')}_${yest}.csv`, csv, `${yestStored.length} orders — ${fmtDate(yest)}`)
  }

  // Fire background scan — no await, runs independently
  fetch(`${origin}/api/cron/scan?date=${yest}${SECRET ? `&secret=${SECRET}` : ''}`)
    .catch(() => {})

  return NextResponse.json({
    ok: true, sent: true,
    yesterday_stored: yestStored.length,
    wtd: wtdO.length, mtd: mtdO.length,
    note: 'Report sent. Background scan triggered for fresh data.'
  })
}
