// Daily cron: 2:30 UTC = 8:00 AM IST
// Sends Telegram morning report from stored run data
// Scanning happens separately via /api/cron/scan (called by this endpoint)
import { NextRequest, NextResponse } from 'next/server'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

export const runtime = 'nodejs'
export const maxDuration = 60

const TG_TOKEN   = process.env.TELEGRAM_BOT_TOKEN || ''
const TG_CHAT    = process.env.TELEGRAM_CHAT_ID   || ''
const SUBDOMAIN  = process.env.BRAND_SUBDOMAIN    || ''
const BRAND_NAME = process.env.BRAND_NAME         || 'Brand'
const SECRET     = process.env.CRON_SECRET        || ''

const tgMsg = async (text: string) => {
  if (!TG_TOKEN || !TG_CHAT) return
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML' })
  })
}

const tgDoc = async (filename: string, content: string, caption: string) => {
  const form = new FormData()
  form.append('chat_id', TG_CHAT)
  form.append('caption', caption)
  form.append('document', new Blob([content], { type: 'text/csv' }), filename)
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendDocument`, { method: 'POST', body: form })
}

const fmt = (n: number) => n >= 100000 ? `₹${(n/100000).toFixed(1)}L` : n >= 1000 ? `₹${(n/1000).toFixed(1)}k` : `₹${n}`
const fmtDate = (d: string) => new Date(d+'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })

function loadRuns(): any[] {
  try {
    const f = join('/tmp/srtscraper', `runs_${SUBDOMAIN}.json`)
    return existsSync(f) ? JSON.parse(readFileSync(f,'utf-8')).runs || [] : []
  } catch { return [] }
}

export async function GET(req: NextRequest) {
  const isVercelCron = req.headers.get('x-vercel-cron') === '1'
  const secret = req.nextUrl.searchParams.get('secret') || ''
  if (!isVercelCron && SECRET && secret !== SECRET)
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  // Validate required env vars
  const missing = ['TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID','BRAND_SUBDOMAIN','BRAND_ANCHOR_ID','BRAND_ANCHOR_DATE']
    .filter(k => !process.env[k])
  if (missing.length > 0) {
    await tgMsg(`⚠️ <b>Daily report failed</b>\nMissing env vars: ${missing.join(', ')}\nAdd these in Vercel → Settings → Environment Variables`)
    return NextResponse.json({ error: 'missing env vars', missing })
  }

  const now    = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }))
  const today  = now.toISOString().split('T')[0]
  const yest   = new Date(now.getTime() - 86400000).toISOString().split('T')[0]
  const dow    = now.getDay() === 0 ? 7 : now.getDay()  // 1=Mon ... 7=Sun
  const wStart = new Date(now.getTime() - (dow-1)*86400000).toISOString().split('T')[0]
  const mStart = today.slice(0,7) + '-01'

  // Trigger background scan for yesterday (fire-and-forget)
  const origin = `https://${req.headers.get('host')}`
  fetch(`${origin}/api/cron/scan?date=${yest}${SECRET?`&secret=${SECRET}`:''}`)
    .catch(() => {}) // don't await — runs in background

  // Read from run-store (populated by browser Sync button or after each scan)
  let all: any[] = []
  try {
    const storeRes = await fetch(`${origin}/api/run-store?subdomain=${SUBDOMAIN}`)
    if (storeRes.ok) {
      const storeData = await storeRes.json()
      all = (storeData.runs || []).flatMap((r: any) => r.orders || [])
    }
  } catch {}
  // Also check /tmp as fallback
  if (all.length === 0) {
    const runs = loadRuns()
    all = runs.flatMap((r: any) => r.orders || [])
  }

  const yestO = all.filter((o:any) => o.dateYMD === yest)
  const wtdO  = all.filter((o:any) => o.dateYMD >= wStart && o.dateYMD <= today)
  const mtdO  = all.filter((o:any) => o.dateYMD >= mStart && o.dateYMD <= today)

  const fmtDate2 = (d: string) => new Date(d+'T00:00:00').toLocaleDateString('en-IN',{day:'numeric',month:'short'})

  const cityMap: Record<string,number> = {}
  yestO.forEach((o:any) => { const c=o.location; if(c&&c!=='N/A') cityMap[c]=(cityMap[c]||0)+1 })
  const topCities = Object.entries(cityMap).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([c,n])=>`${c} (${n})`).join(' · ')

  const yLine = yestO.length > 0
    ? [`📦 ${yestO.length} orders`, topCities ? `📍 ${topCities}` : ''].filter(Boolean).join('\n')
    : `No data yet — scanning now...`

  const msg = [
    `🌅 <b>Morning Report</b> — ${BRAND_NAME}`,
    `📅 <b>Yesterday</b> (${fmtDate2(yest)})`,
    yLine, '',
    `📊 <b>Week to Date</b> (from ${fmtDate2(wStart)}): <b>${wtdO.length}</b> orders`,
    `📈 <b>Month to Date</b>: <b>${mtdO.length}</b> orders`,
    '',
    `<i>Auto report · srtscrap.vercel.app</i>`
  ].join('\n')

  await tgMsg(msg)

  if (yestO.length > 0) {
    const csv = 'Order ID,Date,Time,Value,Payment,Status,Location,Pincode\n' +
      yestO.map((o:any) => `${o.orderId},${o.orderDate},${o.orderTime},${o.value},${o.payment},${o.status},${o.location},${o.pincode}`).join('\n')
    await tgDoc(`${BRAND_NAME.replace(/\s+/g,'_')}_${yest}.csv`, csv, `${yestO.length} orders — ${fmtDate2(yest)}`)
  }

  return NextResponse.json({ ok: true, yesterday: yestO.length, wtd: wtdO.length, mtd: mtdO.length })
}
