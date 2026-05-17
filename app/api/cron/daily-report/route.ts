// Runs daily at 2:30 UTC = 8:00 AM IST
// Required env vars: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, BRAND_SUBDOMAIN, BRAND_NAME
// Optional: CRON_SECRET (for manual trigger security)
import { NextRequest, NextResponse } from 'next/server'
export const runtime = 'nodejs'

const TG_TOKEN   = process.env.TELEGRAM_BOT_TOKEN || ''
const TG_CHAT    = process.env.TELEGRAM_CHAT_ID   || ''
const SUBDOMAIN  = process.env.BRAND_SUBDOMAIN    || ''
const BRAND_NAME = process.env.BRAND_NAME         || 'Brand'
const SECRET     = process.env.CRON_SECRET        || ''

const tgPost = async (token: string, method: string, body: any) =>
  fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })

async function sendDoc(token: string, chat: string, filename: string, content: string, caption: string) {
  const form = new FormData()
  form.append('chat_id', chat)
  form.append('caption', caption)
  form.append('document', new Blob([content], { type: 'text/csv' }), filename)
  await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: form })
}

const fmt = (n: number) =>
  n >= 100000 ? `₹${(n/100000).toFixed(1)}L` : n >= 1000 ? `₹${(n/1000).toFixed(1)}k` : `₹${n}`

const fmtDate = (d: string) =>
  new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })

function calcStats(orders: any[]) {
  const rev  = orders.reduce((s, o) => s + (o.valueNum || 0), 0)
  const cod  = orders.filter(o => (o.payment || '').toUpperCase() === 'COD').length
  return { count: orders.length, rev: Math.round(rev), cod, prepaid: orders.length - cod, avg: orders.length ? Math.round(rev / orders.length) : 0 }
}

export async function GET(req: NextRequest) {
  const isVercelCron = req.headers.get('x-vercel-cron') === '1'
  const secret = req.nextUrl.searchParams.get('secret') || req.headers.get('authorization') || ''
  if (!isVercelCron && SECRET && secret !== SECRET)
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  if (!TG_TOKEN || !TG_CHAT || !SUBDOMAIN)
    return NextResponse.json({ error: 'Missing env vars: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, BRAND_SUBDOMAIN' })

  // Fetch stored run data
  const origin = `https://${req.headers.get('host')}`
  const store = await fetch(`${origin}/api/run-store?subdomain=${SUBDOMAIN}`)
    .then(r => r.json()).catch(() => null)

  if (!store?.runs?.length) {
    await tgPost(TG_TOKEN, 'sendMessage', {
      chat_id: TG_CHAT,
      text: `ℹ️ <b>${BRAND_NAME}</b>\nNo scan data available. Run a scan from the app first.`,
      parse_mode: 'HTML'
    })
    return NextResponse.json({ sent: false, reason: 'no data' })
  }

  const allOrders: any[] = store.runs.flatMap((r: any) => r.orders || [])

  // Compute date ranges in IST
  const now   = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }))
  const today = now.toISOString().split('T')[0]
  const yest  = new Date(now.getTime() - 86400000).toISOString().split('T')[0]
  // Week starts Monday
  const dow   = now.getDay() || 7
  const wStart= new Date(now.getTime() - (dow - 1) * 86400000).toISOString().split('T')[0]
  const mStart= today.slice(0, 7) + '-01'

  const yestOrders = allOrders.filter(o => o.dateYMD === yest)
  const wtdOrders  = allOrders.filter(o => o.dateYMD >= wStart && o.dateYMD <= today)
  const mtdOrders  = allOrders.filter(o => o.dateYMD >= mStart && o.dateYMD <= today)

  const y = calcStats(yestOrders)
  const w = calcStats(wtdOrders)
  const m = calcStats(mtdOrders)

  // Top cities yesterday
  const cityMap: Record<string,number> = {}
  yestOrders.forEach((o: any) => { const c = o.location; if (c && c !== 'N/A') cityMap[c] = (cityMap[c]||0)+1 })
  const topCities = Object.entries(cityMap).sort((a,b) => b[1]-a[1]).slice(0,3)
    .map(([c,n]) => `${c} (${n})`).join(' · ')

  const lines = [
    `🌅 <b>Morning Report</b> — ${BRAND_NAME}`,
    '',
    `📅 <b>Yesterday</b> (${fmtDate(yest)})`,
    y.count > 0
      ? [`📦 ${y.count} orders | ${fmt(y.rev)} | Avg ₹${y.avg}`,
         `💳 COD: ${y.cod} (${y.count?Math.round(y.cod/y.count*100):0}%) · Prepaid: ${y.prepaid}`,
         topCities ? `📍 ${topCities}` : ''
        ].filter(Boolean).join('\n')
      : 'No orders found for yesterday',
    '',
    `📊 <b>Week to Date</b> (from ${fmtDate(wStart)}): <b>${w.count}</b> orders · ${fmt(w.rev)}`,
    `📈 <b>Month to Date</b> (${now.toLocaleDateString('en-IN',{month:'long'})}): <b>${m.count}</b> orders · ${fmt(m.rev)}`,
  ].join('\n')

  await tgPost(TG_TOKEN, 'sendMessage', { chat_id: TG_CHAT, text: lines, parse_mode: 'HTML' })

  // Attach yesterday's CSV
  if (yestOrders.length > 0) {
    const csv = 'Order ID,Date,Time,Value,Payment,Status,Location,Pincode\n' +
      yestOrders.map(o =>
        `${o.orderId},${o.orderDate},${o.orderTime},${o.value},${o.payment},${o.status},${o.location},${o.pincode}`
      ).join('\n')
    await sendDoc(TG_TOKEN, TG_CHAT, `${BRAND_NAME.replace(/\s+/g,'_')}_${yest}.csv`, csv,
      `Full list: ${y.count} orders for ${fmtDate(yest)}`)
  }

  return NextResponse.json({ sent: true, yesterday: y.count, wtd: w.count, mtd: m.count })
}
