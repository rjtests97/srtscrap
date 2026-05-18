// Daily cron: 2:30 UTC = 8:00 AM IST
// Scans yesterday's orders directly from Shiprocket, then sends Telegram report
// No dependency on stored data — always fresh
import { NextRequest, NextResponse } from 'next/server'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'

export const runtime = 'nodejs'
export const maxDuration = 60

const TG_TOKEN   = process.env.TELEGRAM_BOT_TOKEN || ''
const TG_CHAT    = process.env.TELEGRAM_CHAT_ID   || ''
const SUBDOMAIN  = process.env.BRAND_SUBDOMAIN    || ''
const BRAND_NAME = process.env.BRAND_NAME         || 'Brand'
const ANCHOR_ID  = parseInt(process.env.BRAND_ANCHOR_ID  || '0')
const ANCHOR_DATE= process.env.BRAND_ANCHOR_DATE  || ''
const ID_PREFIX  = process.env.BRAND_ID_PREFIX    || ''
const SECRET     = process.env.CRON_SECRET        || ''

const MONTHS: Record<string,string> = {Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12'}
const TMP = '/tmp/srtscraper'
const sleep = (ms:number) => new Promise(r=>setTimeout(r,ms))

function toYMD(s:string){
  if(!s)return null
  const m1=s.match(/^(\d{1,2})\s+(\w{3})\s+(\d{4})/)
  if(m1)return`${m1[3]}-${MONTHS[m1[2]]||'00'}-${m1[1].padStart(2,'0')}`
  const m2=s.match(/^(\d{4}-\d{2}-\d{2})/)
  return m2?m2[1]:null
}

// Load historical runs from /tmp (written by scan endpoint or browser sync)
function loadAllOrders(): any[] {
  try {
    const f = join(TMP,`runs_${SUBDOMAIN}.json`)
    if(!existsSync(f))return []
    return JSON.parse(readFileSync(f,'utf-8')).runs?.flatMap((r:any)=>r.orders||[]) || []
  } catch { return [] }
}

function saveRun(orders:any[], dateStr:string){
  try{
    if(!existsSync(TMP))mkdirSync(TMP,{recursive:true})
    const f=join(TMP,`runs_${SUBDOMAIN}.json`)
    const existing=existsSync(f)?JSON.parse(readFileSync(f,'utf-8')).runs||[]:[]
    const newRun={runId:Date.now().toString(),dateRange:dateStr,found:orders.length,orders,createdAt:new Date().toLocaleDateString('en-IN')}
    writeFileSync(f,JSON.stringify({subdomain:SUBDOMAIN,runs:[newRun,...existing].slice(0,60),updatedAt:Date.now()}))
  }catch{}
}

function loadRegPts(): Array<{date:string,id:number}> {
  try{
    const f=join(TMP,`regpts_${SUBDOMAIN}.json`)
    if(!existsSync(f)){
      // Build from existing runs
      const orders=loadAllOrders()
      const byD:Record<string,{min:number,max:number}>={}
      orders.forEach((o:any)=>{if(!o.dateYMD)return;const n=parseInt(String(o.orderId).replace(/\D/g,''))||0;if(!byD[o.dateYMD])byD[o.dateYMD]={min:n,max:n};else{byD[o.dateYMD].min=Math.min(byD[o.dateYMD].min,n);byD[o.dateYMD].max=Math.max(byD[o.dateYMD].max,n)}})
      return Object.entries(byD).map(([date,{min,max}])=>({date,id:Math.round((min+max)/2)})).sort((a,b)=>a.date.localeCompare(b.date)).slice(-30)
    }
    return JSON.parse(readFileSync(f,'utf-8'))
  }catch{return[]}
}
function saveRegPts(pts:any[]){try{if(!existsSync(TMP))mkdirSync(TMP,{recursive:true});writeFileSync(join(TMP,`regpts_${SUBDOMAIN}.json`),JSON.stringify(pts))}catch{}}

const tgMsg=async(text:string)=>{
  if(!TG_TOKEN||!TG_CHAT)return
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:TG_CHAT,text,parse_mode:'HTML'})})
}
const tgDoc=async(filename:string,content:string,caption:string)=>{
  const form=new FormData();form.append('chat_id',TG_CHAT);form.append('caption',caption);form.append('document',new Blob([content],{type:'text/csv'}),filename)
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendDocument`,{method:'POST',body:form})
}

const fmtDate=(d:string)=>new Date(d+'T00:00:00').toLocaleDateString('en-IN',{day:'numeric',month:'short'})

export async function GET(req: NextRequest) {
  const isVercelCron = req.headers.get('x-vercel-cron')==='1'
  const secret = req.nextUrl.searchParams.get('secret')||''
  if(!isVercelCron&&SECRET&&secret!==SECRET)
    return NextResponse.json({error:'unauthorized'},{status:401})

  // Validate env vars
  const missing=['TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID','BRAND_SUBDOMAIN','BRAND_ANCHOR_ID','BRAND_ANCHOR_DATE'].filter(k=>!process.env[k])
  if(missing.length>0){
    await tgMsg(`⚠️ <b>Daily report failed</b>\nMissing: ${missing.join(', ')}`)
    return NextResponse.json({error:'missing env vars',missing})
  }

  // Date calculations in IST
  const now    = new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Kolkata'}))
  const today  = now.toISOString().split('T')[0]
  const yest   = new Date(now.getTime()-86400000).toISOString().split('T')[0]
  const dow    = now.getDay()===0?7:now.getDay()
  const wStart = new Date(now.getTime()-(dow-1)*86400000).toISOString().split('T')[0]
  const mStart = today.slice(0,7)+'-01'
  const origin = `https://${req.headers.get('host')}`

  // ── STEP 1: Scan yesterday's orders directly ──────────
  await tgMsg(`🔍 Scanning ${BRAND_NAME} — ${fmtDate(yest)}...`)

  const pts=[{date:ANCHOR_DATE,id:ANCHOR_ID},...loadRegPts()].filter(p=>p.date&&p.id>0).sort((a,b)=>a.date.localeCompare(b.date))
  const closest=(d:string)=>pts.reduce((b,p)=>Math.abs(new Date(p.date+'T00:00:00').getTime()-new Date(d+'T00:00:00').getTime())<Math.abs(new Date(b.date+'T00:00:00').getTime()-new Date(d+'T00:00:00').getTime())?p:b,pts[0])

  // Walk to find ID bracket for yesterday
  const walk=async(refId:number,refDate:string,target:string)=>{
    const fwd=target>refDate;let lo=refId,hi=refId
    for(let i=1;i<=100;i++){
      const pid=fwd?refId+i*500:Math.max(1,refId-i*500)
      try{
        const r=await fetch(`${origin}/api/proxy`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subdomain:SUBDOMAIN,ids:[ID_PREFIX?`${ID_PREFIX}${pid}`:pid]}),signal:AbortSignal.timeout(8000)})
        if(r.ok){const{results}=await r.json();const o=results[0];if(o&&o!=='rl'&&o.dateYMD){const n=parseInt(String(o.orderId).replace(/\D/g,''))||pid;if(fwd){if(o.dateYMD>=target){hi=n;break};lo=n;const dl=(new Date(target+'T00:00:00').getTime()-new Date(o.dateYMD+'T00:00:00').getTime())/86400000;if(dl<=5){hi=n+3000;break}}else{if(o.dateYMD<target){lo=n;break};hi=n}}else if(o===null&&fwd&&lo>refId){hi=lo+1500;break}}
      }catch{}
      await sleep(200)
    }
    if(hi<=lo)hi=lo+2000;return{lo,hi}
  }

  const ref=closest(yest)
  const fromB=await walk(ref.id,ref.date,yest)
  const nextD=new Date(new Date(yest+'T00:00:00').getTime()+86400000).toISOString().split('T')[0]
  const refE=fromB.lo>closest(nextD).id?{id:fromB.lo,date:yest}:closest(nextD)
  const toB=await walk(refE.id,refE.date,nextD)
  const scanStart=Math.max(1,fromB.lo-30)
  const scanEnd=toB.hi+30

  console.log(`Scan range: #${scanStart}-#${scanEnd} (${scanEnd-scanStart+1} IDs)`)

  // Scan IDs — 10 per batch, 500ms between batches
  const yestOrders:any[]=[]
  let rlStreak=0

  for(let b=scanStart;b<=scanEnd;b+=10){
    const ids=Array.from({length:Math.min(10,scanEnd-b+1)},(_,i)=>b+i)
    try{
      const res=await fetch(`${origin}/api/proxy`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subdomain:SUBDOMAIN,ids:ids.map(id=>ID_PREFIX?`${ID_PREFIX}${id}`:id)}),signal:AbortSignal.timeout(15000)})
      if(res.ok){
        const{results}=await res.json()
        const allRl=results.every((r:any)=>r==='rl')
        if(allRl){rlStreak++;await sleep(Math.min(rlStreak*5000,20000))}
        else{rlStreak=Math.max(0,rlStreak-1);results.forEach((o:any)=>{if(o&&o!=='rl'&&o.dateYMD===yest)yestOrders.push(o)})}
      }
    }catch{}
    await sleep(rlStreak>0?1500:500)
  }

  // Save run + update regression points
  saveRun(yestOrders,yest)
  const newRegPts=Object.values(Object.fromEntries([...pts,...yestOrders.reduce((acc:any,o:any)=>{
    if(!o.dateYMD)return acc;const n=parseInt(String(o.orderId).replace(/\D/g,''))||0
    if(!acc[o.dateYMD])acc[o.dateYMD]={date:o.dateYMD,id:n};else acc[o.dateYMD].id=Math.round((acc[o.dateYMD].id+n)/2);return acc
  },{}) as any].map((p:any)=>[p.date,p]))).sort((a:any,b:any)=>a.date.localeCompare(b.date)).slice(-30)
  saveRegPts(newRegPts as any[])

  // ── STEP 2: Load historical for WTD/MTD ──────────────
  const histOrders=loadAllOrders()
  const allOrders=[...yestOrders,...histOrders.filter((o:any)=>o.dateYMD!==yest)]
  const wtdO=allOrders.filter((o:any)=>o.dateYMD>=wStart&&o.dateYMD<=today)
  const mtdO=allOrders.filter((o:any)=>o.dateYMD>=mStart&&o.dateYMD<=today)

  // ── STEP 3: Send report ───────────────────────────────
  const cityMap:Record<string,number>={}
  yestOrders.forEach((o:any)=>{const c=o.location;if(c&&c!=='N/A')cityMap[c]=(cityMap[c]||0)+1})
  const topCities=Object.entries(cityMap).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([c,n])=>`${c} (${n})`).join(' · ')

  const yLine=yestOrders.length>0
    ?[`📦 ${yestOrders.length} orders`,topCities?`📍 ${topCities}`:''  ].filter(Boolean).join('\n')
    :'No orders found'

  const msg=[
    `🌅 <b>Morning Report</b> — ${BRAND_NAME}`,
    `📅 <b>Yesterday</b> (${fmtDate(yest)})`,
    yLine,'',
    `📊 <b>Week to Date</b> (from ${fmtDate(wStart)}): <b>${wtdO.length}</b> orders`,
    `📈 <b>Month to Date</b>: <b>${mtdO.length}</b> orders`,
    '',
    `<i>Auto-scanned · srtscrap.vercel.app</i>`
  ].join('\n')

  await tgMsg(msg)

  if(yestOrders.length>0){
    const csv='Order ID,Date,Time,Status,Location,Pincode\n'+
      yestOrders.map((o:any)=>`${o.orderId},${o.orderDate},${o.orderTime},${o.status},${o.location},${o.pincode}`).join('\n')
    await tgDoc(`${BRAND_NAME.replace(/\s+/g,'_')}_${yest}.csv`,csv,`${yestOrders.length} orders — ${fmtDate(yest)}`)
  }

  return NextResponse.json({ok:true,scanned:scanEnd-scanStart+1,yesterday:yestOrders.length,wtd:wtdO.length,mtd:mtdO.length})
}
