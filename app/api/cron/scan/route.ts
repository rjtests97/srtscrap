import { NextRequest, NextResponse } from 'next/server'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'

export const runtime = 'nodejs'
export const maxDuration = 60

const SUBDOMAIN  = process.env.BRAND_SUBDOMAIN   || ''
const BRAND_NAME = process.env.BRAND_NAME        || 'Brand'
const ANCHOR_ID  = parseInt(process.env.BRAND_ANCHOR_ID || '0')
const ANCHOR_DATE= process.env.BRAND_ANCHOR_DATE || ''
const ID_PREFIX  = process.env.BRAND_ID_PREFIX   || ''
const TG_TOKEN   = process.env.TELEGRAM_BOT_TOKEN|| ''
const TG_CHAT    = process.env.TELEGRAM_CHAT_ID  || ''
const SECRET     = process.env.CRON_SECRET       || ''

const TMP = '/tmp/srtscraper'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const MONTHS: Record<string,string> = {Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12'}

function toYMD(s: string) {
  if (!s) return null
  const m1 = s.match(/^(\d{1,2})\s+(\w{3})\s+(\d{4})/)
  if (m1) return `${m1[3]}-${MONTHS[m1[2]]||'00'}-${m1[1].padStart(2,'0')}`
  const m2 = s.match(/^(\d{4}-\d{2}-\d{2})/)
  return m2 ? m2[1] : null
}

function ensureDir() { if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true }) }

function loadData() {
  try {
    const f = join(TMP, `runs_${SUBDOMAIN}.json`)
    if (!existsSync(f)) return { runs: [], regPts: [] }
    const d = JSON.parse(readFileSync(f, 'utf-8'))
    const orders = (d.runs || []).flatMap((r: any) => r.orders || [])
    const byD: Record<string, {min:number,max:number}> = {}
    orders.forEach((o: any) => {
      if (!o.dateYMD) return
      const n = parseInt(String(o.orderId).replace(/\D/g,'')) || 0
      if (!byD[o.dateYMD]) byD[o.dateYMD] = {min:n,max:n}
      else { byD[o.dateYMD].min=Math.min(byD[o.dateYMD].min,n); byD[o.dateYMD].max=Math.max(byD[o.dateYMD].max,n) }
    })
    const regPts = Object.entries(byD).map(([date,{min,max}]) => ({date, id:Math.round((min+max)/2)}))
      .sort((a,b) => a.date.localeCompare(b.date)).slice(-30)
    return { runs: d.runs || [], regPts }
  } catch { return { runs: [], regPts: [] } }
}

function saveRun(orders: any[], dateStr: string, existingRuns: any[]) {
  ensureDir()
  const run = { runId: Date.now().toString(), dateRange: dateStr, found: orders.length, orders, createdAt: new Date().toLocaleDateString('en-IN') }
  const runs = [run, ...existingRuns.filter((r:any) => r.dateRange !== dateStr)].slice(0, 60)
  writeFileSync(join(TMP, `runs_${SUBDOMAIN}.json`), JSON.stringify({ subdomain: SUBDOMAIN, runs, updatedAt: Date.now() }))
  return runs
}

// Load or init scan state for chunked scanning
function loadState(dateStr: string) {
  try {
    const f = join(TMP, `state_${SUBDOMAIN}_${dateStr}.json`)
    return existsSync(f) ? JSON.parse(readFileSync(f,'utf-8')) : null
  } catch { return null }
}
function saveState(dateStr: string, state: any) {
  ensureDir()
  writeFileSync(join(TMP, `state_${SUBDOMAIN}_${dateStr}.json`), JSON.stringify(state))
}
function clearState(dateStr: string) {
  try { const {unlinkSync} = require('fs'); unlinkSync(join(TMP, `state_${SUBDOMAIN}_${dateStr}.json`)) } catch {}
}

const tgMsg = async (text: string) => {
  if (!TG_TOKEN || !TG_CHAT) return
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML' })
  })
}
const tgDoc = async (filename: string, csv: string, caption: string) => {
  const form = new FormData()
  form.append('chat_id', TG_CHAT); form.append('caption', caption)
  form.append('document', new Blob([csv], { type: 'text/csv' }), filename)
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendDocument`, { method: 'POST', body: form })
}

const fmtDate = (d: string) =>
  new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })

export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get('secret') || ''
  const isVercelCron = req.headers.get('x-vercel-cron') === '1'
  if (!isVercelCron && SECRET && secret !== SECRET)
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  if (!SUBDOMAIN || !ANCHOR_ID || !ANCHOR_DATE)
    return NextResponse.json({ error: 'missing env vars' })

  const dateStr = req.nextUrl.searchParams.get('date') ||
    new Date(Date.now() - 86400000).toISOString().split('T')[0]
  const origin = `https://${req.headers.get('host')}`

  const { runs: existingRuns, regPts } = loadData()
  const pts = [{ date: ANCHOR_DATE, id: ANCHOR_ID }, ...regPts]
    .filter(p => p.date && p.id > 0).sort((a, b) => a.date.localeCompare(b.date))
  const closest = (d: string) => pts.reduce((b, p) =>
    Math.abs(new Date(p.date+'T00:00:00').getTime() - new Date(d+'T00:00:00').getTime()) <
    Math.abs(new Date(b.date+'T00:00:00').getTime() - new Date(d+'T00:00:00').getTime()) ? p : b, pts[0])

  // Load or init state
  let state = loadState(dateStr)
  let scanStart: number
  let scanEnd: number
  let collectedOrders: any[] = state?.orders || []

  if (!state) {
    // Find scan boundaries via fast walk
    const walk = async (refId: number, refDate: string, target: string) => {
      const fwd = target > refDate; let lo = refId, hi = refId
      for (let i = 1; i <= 60 && !(fwd ? hi > refId : lo < refId); i++) {
        const pid = fwd ? refId + i*500 : Math.max(1, refId - i*500)
        try {
          const res = await fetch(`${origin}/api/proxy`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subdomain: SUBDOMAIN, ids: [ID_PREFIX ? `${ID_PREFIX}${pid}` : pid] }),
            signal: AbortSignal.timeout(8000)
          })
          if (res.ok) {
            const { results } = await res.json(); const o = results[0]
            if (o && o !== 'rl' && o.dateYMD) {
              const n = parseInt(String(o.orderId).replace(/\D/g,'')) || pid
              if (fwd) { if (o.dateYMD >= target) { hi=n; break }; lo=n; const dl=(new Date(target+'T00:00:00').getTime()-new Date(o.dateYMD+'T00:00:00').getTime())/86400000; if(dl<=5){hi=n+3000;break} }
              else { if (o.dateYMD < target) { lo=n; break }; hi=n }
            } else if (o === null && fwd && lo > refId) { hi=lo+1500; break }
          }
        } catch {}
        await sleep(150)
      }
      if (hi <= lo) hi = lo + 2000; return { lo, hi }
    }

    const ref = closest(dateStr)
    const fromB = await walk(ref.id, ref.date, dateStr)
    const nextD = new Date(new Date(dateStr+'T00:00:00').getTime()+86400000).toISOString().split('T')[0]
    const refE = fromB.lo > closest(nextD).id ? {id:fromB.lo,date:dateStr} : closest(nextD)
    const toB = await walk(refE.id, refE.date, nextD)
    scanStart = Math.max(1, fromB.lo - 30)
    scanEnd = toB.hi + 30
  } else {
    scanStart = state.nextId
    scanEnd = state.scanEnd
  }

  console.log(`Scan ${dateStr}: #${scanStart}-#${scanEnd} (${scanEnd-scanStart+1} IDs)`)

  // Scan up to 300 IDs this invocation (safe within 60s)
  const CHUNK = 300, BATCH = 10
  const chunkEnd = Math.min(scanStart + CHUNK - 1, scanEnd)
  let rlStreak = 0

  for (let b = scanStart; b <= chunkEnd; b += BATCH) {
    const ids = Array.from({ length: Math.min(BATCH, chunkEnd-b+1) }, (_,i) => b+i)
    try {
      const res = await fetch(`${origin}/api/proxy`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subdomain: SUBDOMAIN, ids: ids.map(id => ID_PREFIX?`${ID_PREFIX}${id}`:id) }),
        signal: AbortSignal.timeout(15000)
      })
      if (res.ok) {
        const { results } = await res.json()
        if (results.every((r:any) => r==='rl')) {
          rlStreak++; await sleep(Math.min(rlStreak*5000, 20000))
        } else {
          rlStreak = Math.max(0, rlStreak-1)
          results.forEach((o:any) => { if (o && o!=='rl' && o.dateYMD===dateStr) collectedOrders.push(o) })
        }
      }
    } catch {}
    await sleep(rlStreak > 0 ? 1200 : 450)
  }

  const nextId = chunkEnd + 1
  const done = nextId > scanEnd

  if (!done) {
    // Save state and trigger next chunk
    saveState(dateStr, { nextId, scanEnd, orders: collectedOrders })
    fetch(`${origin}/api/cron/scan?date=${dateStr}${SECRET?`&secret=${SECRET}`:''}`)
      .catch(() => {})
    return NextResponse.json({ ok:true, done:false, scanned:`${scanStart}-${chunkEnd}`, found:collectedOrders.length, remaining:scanEnd-nextId+1 })
  }

  // Done — save and send follow-up Telegram
  clearState(dateStr)
  saveRun(collectedOrders, dateStr, existingRuns)

  if (TG_TOKEN && TG_CHAT) {
    const cityMap: Record<string,number> = {}
    collectedOrders.forEach((o:any) => { const c=o.location; if(c&&c!=='N/A') cityMap[c]=(cityMap[c]||0)+1 })
    const top = Object.entries(cityMap).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([c,n])=>`${c} (${n})`).join(' · ')
    const followUp = [`✅ <b>Scan complete</b> — ${BRAND_NAME}`, `📅 ${fmtDate(dateStr)}: <b>${collectedOrders.length}</b> orders found`, top?`📍 ${top}`:''].filter(Boolean).join('\n')
    await tgMsg(followUp)

    if (collectedOrders.length > 0) {
      const csv = 'Order ID,Date,Time,Status,Location,Pincode\n' +
        collectedOrders.map((o:any)=>`${o.orderId},${o.orderDate},${o.orderTime},${o.status},${o.location},${o.pincode}`).join('\n')
      await tgDoc(`${BRAND_NAME.replace(/\s+/g,'_')}_${dateStr}.csv`, csv, `${collectedOrders.length} orders — ${fmtDate(dateStr)}`)
    }
  }

  return NextResponse.json({ ok:true, done:true, date:dateStr, found:collectedOrders.length })
}
