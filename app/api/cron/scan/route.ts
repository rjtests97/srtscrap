// Background scan endpoint — scans a specific date and saves to /tmp store
// Called by daily-report cron (fire-and-forget) or manually
import { NextRequest, NextResponse } from 'next/server'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'

export const runtime = 'nodejs'
export const maxDuration = 60

const SUBDOMAIN  = process.env.BRAND_SUBDOMAIN    || ''
const BRAND_NAME = process.env.BRAND_NAME         || 'Brand'
const ANCHOR_ID  = parseInt(process.env.BRAND_ANCHOR_ID || '0')
const ANCHOR_DATE= process.env.BRAND_ANCHOR_DATE  || ''
const ID_PREFIX  = process.env.BRAND_ID_PREFIX    || ''
const TG_TOKEN   = process.env.TELEGRAM_BOT_TOKEN || ''
const TG_CHAT    = process.env.TELEGRAM_CHAT_ID   || ''
const SECRET     = process.env.CRON_SECRET        || ''
const MONTHS: Record<string,string> = {Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12'}

const TMP = '/tmp/srtscraper'
const runsFile  = () => join(TMP, `runs_${SUBDOMAIN}.json`)
const regFile   = () => join(TMP, `regpts_${SUBDOMAIN}.json`)
const scanState = () => join(TMP, `scan_${SUBDOMAIN}.json`)

function ensureDir() { if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true }) }
function loadRuns(): any[] { try { return existsSync(runsFile()) ? JSON.parse(readFileSync(runsFile(),'utf-8')).runs||[] : [] } catch { return [] } }
function saveRuns(r:any[]) { ensureDir(); writeFileSync(runsFile(), JSON.stringify({subdomain:SUBDOMAIN,runs:r,updatedAt:Date.now()})) }
function loadReg(): Array<{date:string,id:number}> { try { return existsSync(regFile()) ? JSON.parse(readFileSync(regFile(),'utf-8')) : [] } catch { return [] } }
function saveReg(p:Array<{date:string,id:number}>) { ensureDir(); writeFileSync(regFile(), JSON.stringify(p)) }

function toYMD(s:string) {
  if(!s)return null
  const m1=s.match(/^(\d{1,2})\s+(\w{3})\s+(\d{4})/)
  if(m1)return`${m1[3]}-${MONTHS[m1[2]]||'00'}-${m1[1].padStart(2,'0')}`
  const m2=s.match(/^(\d{4}-\d{2}-\d{2})/)
  return m2?m2[1]:null
}

const sleep = (ms:number) => new Promise(r=>setTimeout(r,ms))

async function fetchBatch(origin:string, ids:number[]): Promise<any[]> {
  try {
    const res = await fetch(`${origin}/api/proxy`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({subdomain:SUBDOMAIN, ids: ids.map(id=>ID_PREFIX?`${ID_PREFIX}${id}`:id)}),
      signal: AbortSignal.timeout(25000)
    })
    if(!res.ok) return ids.map(()=>'rl')
    const {results} = await res.json()
    return results
  } catch { return ids.map(()=>'rl') }
}

async function tgMsg(text:string) {
  if(!TG_TOKEN||!TG_CHAT)return
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:TG_CHAT,text,parse_mode:'HTML'})})
}

export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get('secret') || ''
  const isVercelCron = req.headers.get('x-vercel-cron') === '1'
  if (!isVercelCron && SECRET && secret !== SECRET)
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const dateStr = req.nextUrl.searchParams.get('date') || new Date(Date.now()-86400000).toISOString().split('T')[0]
  const origin  = `https://${req.headers.get('host')}`

  if (!SUBDOMAIN || !ANCHOR_ID || !ANCHOR_DATE)
    return NextResponse.json({ error: 'missing env vars' })

  // Load or initialise scan state (for multi-chunk scanning)
  ensureDir()
  let state: any = null
  try { state = existsSync(scanState()) ? JSON.parse(readFileSync(scanState(),'utf-8')) : null } catch {}
  if (state?.date !== dateStr) state = null  // fresh scan for this date

  // Load regression points — build from stored runs if first time
  let regPts = loadReg()
  if (regPts.length === 0) {
    const allO = loadRuns().flatMap((r:any)=>r.orders||[])
    const byD:Record<string,{min:number,max:number}>= {}
    allO.forEach((o:any)=>{ if(!o.dateYMD)return; const n=parseInt(String(o.orderId).replace(/\D/g,''))||0; if(!byD[o.dateYMD])byD[o.dateYMD]={min:n,max:n}; else{byD[o.dateYMD].min=Math.min(byD[o.dateYMD].min,n);byD[o.dateYMD].max=Math.max(byD[o.dateYMD].max,n)} })
    regPts = Object.entries(byD).map(([date,{min,max}])=>({date,id:Math.round((min+max)/2)})).sort((a,b)=>a.date.localeCompare(b.date)).slice(-30)
  }

  // Find scan range if not resuming
  let scanStart = state?.nextId || 0
  let scanEnd   = state?.scanEnd || 0

  if (!scanStart) {
    const pts = [{date:ANCHOR_DATE,id:ANCHOR_ID},...regPts].filter(p=>p.date&&p.id>0).sort((a,b)=>a.date.localeCompare(b.date))
    const closest = (d:string) => pts.reduce((b,p)=>Math.abs(new Date(p.date+'T00:00:00').getTime()-new Date(d+'T00:00:00').getTime())<Math.abs(new Date(b.date+'T00:00:00').getTime()-new Date(d+'T00:00:00').getTime())?p:b,pts[0])

    // Quick walk to find brackets
    const walk = async (refId:number,refDate:string,target:string) => {
      const fwd = target>refDate; let lo=refId,hi=refId
      for(let i=1;i<=200;i++){
        const pid=fwd?refId+i*500:Math.max(1,refId-i*500)
        const res=await fetchBatch(origin,[pid])
        const o=res[0]
        if(o&&o!=='rl'&&o.dateYMD){
          const n=parseInt(String(o.orderId).replace(/\D/g,''))||pid
          if(fwd){if(o.dateYMD>=target){hi=n;break};lo=n;const dl=(new Date(target+'T00:00:00').getTime()-new Date(o.dateYMD+'T00:00:00').getTime())/86400000;if(dl<=5){hi=n+3000;break}}
          else{if(o.dateYMD<target){lo=n;break};hi=n}
        }else if(o===null&&fwd&&lo>refId){hi=lo+1500;break}
        await sleep(300)
      }
      if(hi<=lo)hi=lo+2000; return{lo,hi}
    }

    const ref = closest(dateStr)
    const fromB = await walk(ref.id,ref.date,dateStr)
    const nextD = new Date(new Date(dateStr+'T00:00:00').getTime()+86400000).toISOString().split('T')[0]
    const refE  = fromB.lo>closest(nextD).id?{id:fromB.lo,date:dateStr}:closest(nextD)
    const toB   = await walk(refE.id,refE.date,nextD)
    scanStart = Math.max(1,fromB.lo-50)
    scanEnd   = toB.hi+50
  }

  // Scan up to 400 IDs per invocation (fits in 60s)
  const CHUNK   = 400
  const BATCH   = 10
  const chunkEnd = Math.min(scanStart + CHUNK - 1, scanEnd)
  const orders: any[] = state?.orders || []
  let rlStreak = 0

  for (let b = scanStart; b <= chunkEnd; b += BATCH) {
    const ids = Array.from({length:Math.min(BATCH,chunkEnd-b+1)},(_,i)=>b+i)
    let results = await fetchBatch(origin, ids)
    if (results.every(r=>r==='rl')) {
      rlStreak++
      await sleep(Math.min(rlStreak*5000, 30000))
      results = await fetchBatch(origin, ids)  // one retry
    } else rlStreak = Math.max(0,rlStreak-1)
    for (const o of results) {
      if (o&&o!=='rl'&&o.dateYMD===dateStr) orders.push(o)
    }
    await sleep(rlStreak>0?1500:400)
  }

  const nextId = chunkEnd + 1
  const done   = nextId > scanEnd

  if (!done) {
    // Save state for next invocation — schedule continuation
    ensureDir()
    writeFileSync(scanState(), JSON.stringify({date:dateStr,nextId,scanEnd,orders,regPts}))
    // Schedule next chunk (fire-and-forget)
    fetch(`${origin}/api/cron/scan?date=${dateStr}${SECRET?`&secret=${SECRET}`:''}`)
      .catch(()=>{})
    return NextResponse.json({ ok:true, done:false, scanned:`${scanStart}-${chunkEnd}`, found:orders.length, remaining:scanEnd-chunkEnd })
  }

  // Done — save run and update regression points
  const newRun = { runId:Date.now().toString(), dateRange:dateStr, found:orders.length, orders, createdAt:new Date().toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'}) }
  const runs   = [newRun,...loadRuns()].slice(0,60)
  saveRuns(runs)

  // Update regression
  const byD:Record<string,{min:number,max:number}>= {}
  orders.forEach((o:any)=>{ if(!o.dateYMD)return; const n=parseInt(String(o.orderId).replace(/\D/g,''))||0; if(!byD[o.dateYMD])byD[o.dateYMD]={min:n,max:n}; else{byD[o.dateYMD].min=Math.min(byD[o.dateYMD].min,n);byD[o.dateYMD].max=Math.max(byD[o.dateYMD].max,n)} })
  const newPts = Object.entries(byD).map(([date,{min,max}])=>({date,id:Math.round((min+max)/2)}))
  const merged = Object.values(Object.fromEntries([...regPts,...newPts].map(p=>[p.date,p]))).sort((a:any,b:any)=>a.date.localeCompare(b.date)) as any[]
  saveReg(merged.slice(-30))

  // Clean up state file
  try { const {unlinkSync}=require('fs'); unlinkSync(scanState()) } catch {}

  // Send scan-complete update to Telegram
  const fmtD=(d:string)=>new Date(d+'T00:00:00').toLocaleDateString('en-IN',{day:'numeric',month:'short'})
  await tgMsg(`✅ <b>Scan complete</b> — ${BRAND_NAME}\n📅 ${fmtD(dateStr)}: ${orders.length} orders found\n(Morning report was already sent)`)

  return NextResponse.json({ ok:true, done:true, date:dateStr, found:orders.length })
}
