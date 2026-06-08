'use client'
import { useState, useEffect, useRef, useCallback, ChangeEvent } from 'react'

interface Brand { id:string; name:string; subdomain:string; slug:string; companyName:string; anchorId:number; anchorDate:string; avgPerDay:number; regressionPoints:Array<{date:string,id:number}>; idPrefix:string }
interface Order { orderId:number|string; slug:string; orderDate:string; orderTime:string; dateYMD:string|null; value:string; valueNum:number; payment:string; status:string; pincode:string; location:string; source?:'cache'|'fresh' }
interface Run { runId:string; dateRange:string; found:number; orders:Order[]; createdAt:string }
interface Analytics {
  totalOrders:number
  totalRevenue:number
  avgOrderVal:number
  codCount:number
  prepaidCount:number
  codPct:number
  topCities:Array<{city:string,count:number}>
  topPincodes:Array<{pincode:string,count:number}>
  repeatLocations:Array<{city:string,count:number}>
  statuses:Array<{status:string,count:number}>
  daily:Array<{date:string,orders:number,revenue:number,cod:number,prepaid:number}>
  hours:Array<{hour:string,count:number}>
  valueBuckets:Record<string,number>
  velocity:string
  avgDailyOrders:number
  avgDailyRevenue:number
  revenueMomentum:number
}
interface ScanStats { retries:number; recovered:number; duplicates:number; gapJumps:number; lastMatchedId:number|null }

const LS = { get:<T,>(k:string,d:T):T=>{try{const v=localStorage.getItem(k);return v?JSON.parse(v):d}catch{return d}}, set:(k:string,v:any)=>{try{localStorage.setItem(k,JSON.stringify(v))}catch{}} }
const sleep = (ms:number) => new Promise(r=>setTimeout(r,ms))
const todayStr=()=>{const d=new Date();return`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
const yestStr=()=>{const d=new Date();d.setDate(d.getDate()-1);return`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
const daysAgoStr=(days:number)=>{const d=new Date();d.setDate(d.getDate()-days);return`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
const monthStartStr=()=>{const d=new Date();return`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-01`}
const sortOrders=(o:Order[])=>[...o].sort((a,b)=>(a.dateYMD||'').localeCompare(b.dateYMD||'')||(a.orderTime||'').localeCompare(b.orderTime||''))
const fmtRs=(n:number)=>'Rs.'+Math.round(n||0).toLocaleString('en-IN')
const esc=(v:any)=>`"${String(v??'').replace(/"/g,'""')}"`
const fmt=(n:number)=>'Rs.'+Number(n||0).toFixed(2)
const RTO=new Set(['HUB','ETAIL','E-TAIL','SORTING','GATEWAY','DEPOT','FACILITY','WAREHOUSE','PROCESSING','COUNTER','DISPATCH','SURFACE'])
const isRTO=(c:string)=>{const u=(c||'').toUpperCase().trim();if(!u||u==='N/A')return true;return u.split(/[\s,\-]+/).some(w=>RTO.has(w))}
const recommendedAutoStop=(concurrency:number,avgPerDay:number)=>Math.max(250,concurrency*100,Math.ceil((avgPerDay||0)*4))
const uniqueOrders=(orders:Order[])=>Object.values(Object.fromEntries(orders.map(o=>[String(o.orderId),o])))
const mergeScanStats=(prev:ScanStats,patch:Partial<ScanStats>):ScanStats=>({
  retries: prev.retries + (patch.retries||0),
  recovered: prev.recovered + (patch.recovered||0),
  duplicates: prev.duplicates + (patch.duplicates||0),
  gapJumps: prev.gapJumps + (patch.gapJumps||0),
  lastMatchedId: patch.lastMatchedId ?? prev.lastMatchedId,
})
const normalizeId=(v:any):number=>{
  const digits=String(v??'').replace(/[^0-9]/g,'')
  const n=digits?Number(digits):NaN
  return Number.isFinite(n)&&n>0?Math.floor(n):0
}
const normalizeStatus=(status:string)=>String(status||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()
const isFinalStatus=(status:string)=>normalizeStatus(status)==='delivered'
const stripSource=(order:Order):Order=>{
  const { source, ...rest } = order
  return rest
}
const mergeOrdersById=(orders:Order[])=>Object.values(Object.fromEntries(orders.map(order=>[String(order.orderId),order])))

function buildAnalytics(orders:Order[]):Analytics|null {
  if(!orders.length)return null
  const N=orders.length,rev=orders.reduce((s,r)=>s+(r.valueNum||0),0)
  const cod=orders.filter(r=>(r.payment||'').toUpperCase()==='COD')
  const cityMap:Record<string,number>={},pinMap:Record<string,number>={},statusMap:Record<string,number>={},dayMap:Record<string,any>={},hourMap:Record<string,number>={},valMap:Record<string,number>={'0-500':0,'500-1k':0,'1k-1.5k':0,'1.5k-2k':0,'2k+':0}
  orders.forEach(r=>{
    const c=(r.location||'N/A').trim();if(!isRTO(c))cityMap[c]=(cityMap[c]||0)+1
    const pin=(r.pincode||'N/A').trim();if(pin&&pin!=='N/A')pinMap[pin]=(pinMap[pin]||0)+1
    const status=(r.status||'N/A').trim();statusMap[status]=(statusMap[status]||0)+1
    if(r.dateYMD){if(!dayMap[r.dateYMD])dayMap[r.dateYMD]={orders:0,revenue:0,cod:0,prepaid:0};dayMap[r.dateYMD].orders++;dayMap[r.dateYMD].revenue+=r.valueNum||0;(r.payment||'').toUpperCase()==='COD'?dayMap[r.dateYMD].cod++:dayMap[r.dateYMD].prepaid++}
    if(r.orderTime&&r.orderTime!=='N/A'){const h=r.orderTime.slice(0,2)+'h';hourMap[h]=(hourMap[h]||0)+1}
    const v=r.valueNum||0;if(v<500)valMap['0-500']++;else if(v<1000)valMap['500-1k']++;else if(v<1500)valMap['1k-1.5k']++;else if(v<2000)valMap['1.5k-2k']++;else valMap['2k+']++
  })
  const topCities=Object.entries(cityMap).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([city,count])=>({city,count}))
  const topPincodes=Object.entries(pinMap).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([pincode,count])=>({pincode,count}))
  const repeatLocations=Object.entries(cityMap).filter(([,count])=>count>1).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([city,count])=>({city,count}))
  const statuses=Object.entries(statusMap).sort((a,b)=>b[1]-a[1]).map(([status,count])=>({status,count}))
  const daily=Object.keys(dayMap).sort().map(k=>({date:k,...dayMap[k]}))
  const hours=Object.entries(hourMap).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([h,c])=>({hour:h,count:c}))
  let velocity='stable',revenueMomentum=0
  if(daily.length>=6){const rec=daily.slice(-3).reduce((s,d)=>s+d.orders,0)/3,old=daily.slice(0,3).reduce((s,d)=>s+d.orders,0)/3;if(rec>old*1.15)velocity='growing';else if(rec<old*0.85)velocity='shrinking';const recRev=daily.slice(-3).reduce((s,d)=>s+d.revenue,0)/3,oldRev=daily.slice(0,3).reduce((s,d)=>s+d.revenue,0)/3;revenueMomentum=oldRev?Math.round(((recRev-oldRev)/oldRev)*100):0}
  return{totalOrders:N,totalRevenue:rev,avgOrderVal:rev/N,codCount:cod.length,prepaidCount:N-cod.length,codPct:Math.round((cod.length/N)*100),topCities,topPincodes,repeatLocations,statuses,daily,hours,valueBuckets:valMap,velocity,avgDailyOrders:Math.round((N/Math.max(daily.length,1))*10)/10,avgDailyRevenue:rev/Math.max(daily.length,1),revenueMomentum}
}

function buildCSV(orders:Order[]){let s='Order ID,Date,Time,Value,Payment,Status,Location,Pincode,Source\n';sortOrders(orders).forEach(r=>s+=`${esc(r.orderId)},${esc(r.orderDate)},${esc(r.orderTime)},${esc(r.value)},${esc(r.payment)},${esc(r.status)},${esc(r.location)},${esc(r.pincode)},${esc(r.source||'fresh')}\n`);return s}
function buildReport(orders:Order[],brandName:string,dateRange:string){
  const a=buildAnalytics(orders);if(!a)return''
  const fd=(ymd:string)=>{const[y,m,d]=ymd.split('-');return new Date(+y,+m-1,+d).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'})}
  let s=`BRAND INTELLIGENCE REPORT\nBrand,${esc(brandName)}\nDate Range,${esc(dateRange)}\nGenerated,${new Date().toLocaleString('en-IN')}\n\n`
  s+=`SUMMARY\nTotal Orders,${a.totalOrders}\nRevenue,${fmt(a.totalRevenue)}\nAvg Value,${fmt(a.avgOrderVal)}\nCOD,${a.codCount} (${a.codPct}%)\nPrepaid,${a.prepaidCount}\nVelocity,${a.velocity}\nAvg Daily Orders,${a.avgDailyOrders}\nAvg Daily Revenue,${fmt(a.avgDailyRevenue)}\nRevenue Momentum,${a.revenueMomentum}%\n\n`
  s+='TOP CITIES\nCity,Orders\n';a.topCities.forEach(c=>s+=`${esc(c.city)},${c.count}\n`)
  s+='\nTOP PINCODES\nPincode,Orders\n';a.topPincodes.forEach(p=>s+=`${esc(p.pincode)},${p.count}\n`)
  s+='\nSTATUS BREAKDOWN\nStatus,Orders\n';a.statuses.forEach(st=>s+=`${esc(st.status)},${st.count}\n`)
  s+='\nREPEAT LOCATIONS\nCity,Orders\n';a.repeatLocations.forEach(c=>s+=`${esc(c.city)},${c.count}\n`)
  s+='\nPEAK HOURS\nHour,Orders\n';a.hours.forEach(h=>s+=`${esc(h.hour)},${h.count}\n`)
  s+='\nVALUE DISTRIBUTION\nBucket,Orders\n';Object.entries(a.valueBuckets).forEach(([k,v])=>s+=`${esc('Rs.'+k)},${v}\n`)
  s+='\nDAILY BREAKDOWN\nDate,Orders,Revenue,COD,Prepaid\n';a.daily.forEach(d=>s+=`${esc(fd(d.date))},${d.orders},${fmt(d.revenue)},${d.cod},${d.prepaid}\n`)
  s+='\nFULL ORDER LIST\nOrder ID,Date,Time,Value,Payment,Status,Location,Pincode\n';sortOrders(orders).forEach(r=>s+=`${esc(r.orderId)},${esc(r.orderDate)},${esc(r.orderTime)},${esc(r.value)},${esc(r.payment)},${esc(r.status)},${esc(r.location)},${esc(r.pincode)}\n`)
  return s
}
// ── Telegram ─────────────────────────────────────────
async function sendTelegramMsg(token:string, chatId:string, text:string){
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({chat_id:chatId,text,parse_mode:'HTML'})
  })
}
async function sendTelegramDoc(token:string, chatId:string, filename:string, csvContent:string, caption:string){
  const form=new FormData()
  form.append('chat_id',chatId)
  form.append('caption',caption)
  form.append('document',new Blob([csvContent],{type:'text/csv'}),filename)
  await fetch(`https://api.telegram.org/bot${token}/sendDocument`,{method:'POST',body:form})
}
function buildTelegramReport(orders:Order[], brandName:string, label:string, yest:string, wStart:string, mStart:string, today:string):string{
  const inRange=(arr:Order[],from:string,to:string)=>arr.filter(o=>o.dateYMD&&o.dateYMD>=from&&o.dateYMD<=to)
  const stats=(arr:Order[])=>{
    const rev=arr.reduce((s,o)=>s+(o.valueNum||0),0)
    const cod=arr.filter(o=>(o.payment||'').toUpperCase()==='COD').length
    return{count:arr.length,rev:Math.round(rev),cod,prepaid:arr.length-cod,avg:arr.length?Math.round(rev/arr.length):0}
  }
  const fmt=(n:number)=>n>=100000?`₹${(n/100000).toFixed(1)}L`:n>=1000?`₹${(n/1000).toFixed(1)}k`:`₹${n}`
  const fd=(d:string)=>new Date(d+'T00:00:00').toLocaleDateString('en-IN',{day:'numeric',month:'short'})
  const y=stats(inRange(orders,yest,yest))
  const w=stats(inRange(orders,wStart,today))
  const m=stats(inRange(orders,mStart,today))
  const cityMap:Record<string,number>={}
  inRange(orders,yest,yest).forEach(o=>{const c=o.location;if(c&&c!=='N/A')cityMap[c]=(cityMap[c]||0)+1})
  const top=Object.entries(cityMap).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([c,n])=>`${c} (${n})`).join(' · ')
  const yLine=y.count>0?[
    `📦 ${y.count} orders`,
    top?`📍 ${top}`:''
  ].filter(Boolean).join('\n'):'No orders found'
  return [`🌅 <b>Morning Report</b> — ${brandName}`,'',`📅 <b>Yesterday</b> (${fd(yest)})`,yLine,'',
    `📊 <b>Week to Date</b> (from ${fd(wStart)}): <b>${w.count}</b> orders`,
    `📈 <b>Month to Date</b>: <b>${m.count}</b> orders`].join('\n')
}

function dlFile(content:string,filename:string){const a=document.createElement('a');a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(content);a.download=filename;a.click()}
function buildWhatsappSummary(orders:Order[],brandName:string,dateRange:string){
  const a=buildAnalytics(orders);if(!a)return''
  const top=a.topCities[0],pin=a.topPincodes[0],status=a.statuses[0]
  return `📦 *${brandName}*\nRange: ${dateRange}\nOrders: *${a.totalOrders}* | Revenue: *${fmtRs(a.totalRevenue)}*\nAOV: ${fmtRs(a.avgOrderVal)} | COD: ${a.codCount} (${a.codPct}%)\nDaily Avg: ${a.avgDailyOrders} orders | ${fmtRs(a.avgDailyRevenue)}\n`+(top?`Top city: ${top.city} (${top.count})\n`:'')+(pin?`Top pin: ${pin.pincode} (${pin.count})\n`:'')+(status?`Lead status: ${status.status} (${status.count})\n`:'')+`Trend: ${a.velocity} | Revenue momentum: ${a.revenueMomentum}%`
}
function buildUnifiedRangeOrders(cache:OrderCache, scannedOrders:Order[], fromDate:string, toDate:string, forceRefresh:boolean):Order[] {
  if (forceRefresh) return mergeOrdersById(scannedOrders)
  const cachedRange = cache.getRange(fromDate, toDate).filter(order => cache.isFinal(order.orderId))
  return mergeOrdersById([...cachedRange, ...scannedOrders])
}

const darkVars={'--bg':'#0d0d0d','--surface':'#161616','--surface2':'#1e1e1e','--border':'#252525','--accent':'#00ff88','--warn':'#ff6b35','--text':'#e8e8e8','--muted':'#555','--red':'#ff4444'}
const lightVars={'--bg':'#f5f5f0','--surface':'#fff','--surface2':'#efefea','--border':'#ddd','--accent':'#008844','--warn':'#cc5500','--text':'#111','--muted':'#888','--red':'#cc2222'}


// ── Order Cache ───────────────────────────────────────
// Persistent full-order cache keyed by Order ID.
// Legacy compact entries are migrated on load and refreshed on first use.
// Only fully cached Delivered orders are treated as final and skipped.

type CacheEntry = Omit<Order,'source'>
interface LegacyCacheEntry { d?:string; dt?:string; t?:string; s?:string; l?:string; p?:string }
interface StoredCacheEntry {
  sg?:string
  dt?:string
  t?:string
  d?:string
  v?:string
  vn?:number
  py?:string
  s?:string
  p?:string
  l?:string
}

class OrderCache {
  private brandId: string
  private brandSlug: string
  private data: Record<string, CacheEntry> = {}
  private dirty = 0

  constructor(brandId: string, brandSlug='') {
    this.brandId = brandId; this.brandSlug = brandSlug
    this.load()
  }

  private key() { return `oc_${this.brandId}` }  // short key

  private load() {
    try {
      const raw = localStorage.getItem(this.key())
      const parsed = raw ? JSON.parse(raw) : {}
      this.data = Object.fromEntries(
        Object.entries(parsed || {}).map(([id, entry]) => [id, this.normalizeEntry(id, entry as CacheEntry | LegacyCacheEntry | StoredCacheEntry)])
      )
    } catch { this.data = {} }
  }

  private normalizeEntry(orderId: string, entry: CacheEntry | LegacyCacheEntry | StoredCacheEntry): CacheEntry {
    const stored = entry as StoredCacheEntry
    if ('sg' in stored || 'py' in stored || 'vn' in stored) {
      return {
        orderId: normalizeId(orderId) || orderId,
        slug: stored.sg || this.brandSlug,
        orderDate: stored.dt || 'N/A',
        orderTime: stored.t || 'N/A',
        dateYMD: stored.d || null,
        value: stored.v || 'N/A',
        valueNum: Number(stored.vn || 0),
        payment: stored.py || 'N/A',
        status: stored.s || 'N/A',
        pincode: stored.p || 'N/A',
        location: stored.l || 'N/A',
      }
    }

    const full = entry as Partial<CacheEntry>
    if ('orderDate' in full || 'payment' in full || 'value' in full) {
      return {
        orderId: normalizeId(full.orderId ?? orderId) || String(full.orderId ?? orderId),
        slug: full.slug || this.brandSlug,
        orderDate: full.orderDate || 'N/A',
        orderTime: full.orderTime || 'N/A',
        dateYMD: full.dateYMD || null,
        value: full.value || 'N/A',
        valueNum: Number(full.valueNum || 0),
        payment: full.payment || 'N/A',
        status: full.status || 'N/A',
        pincode: full.pincode || 'N/A',
        location: full.location || 'N/A',
      }
    }

    const legacy = entry as LegacyCacheEntry
    return {
      orderId: normalizeId(orderId) || orderId,
      slug: this.brandSlug,
      orderDate: legacy.dt || 'N/A',
      orderTime: legacy.t || 'N/A',
      dateYMD: legacy.d || null,
      value: 'N/A',
      valueNum: 0,
      payment: 'N/A',
      status: legacy.s || 'N/A',
      pincode: legacy.p || 'N/A',
      location: legacy.l || 'N/A',
    }
  }

  private canTreatAsFinal(entry: CacheEntry) {
    return isFinalStatus(entry.status)
  }

  private flush() {
    try {
      const serialized = Object.fromEntries(
        Object.entries(this.data).map(([id, entry]) => [id, this.serializeEntry(entry)])
      )
      localStorage.setItem(this.key(), JSON.stringify(serialized))
      this.dirty = 0
    } catch(e) {
      console.error('OrderCache flush failed:', e, 'entries:', Object.keys(this.data).length)
      this.dirty = 0
    }
  }

  private serializeEntry(entry: CacheEntry): StoredCacheEntry {
    return {
      sg: entry.slug || '',
      dt: entry.orderDate || 'N/A',
      t: entry.orderTime || 'N/A',
      d: entry.dateYMD || '',
      v: entry.value || 'N/A',
      vn: Number(entry.valueNum || 0),
      py: entry.payment || 'N/A',
      s: entry.status || 'N/A',
      p: entry.pincode || 'N/A',
      l: entry.location || 'N/A',
    }
  }

  private compact(o: Order): CacheEntry {
    return {
      orderId: o.orderId,
      slug: o.slug || this.brandSlug,
      orderDate: o.orderDate || 'N/A',
      orderTime: o.orderTime || 'N/A',
      dateYMD: o.dateYMD || null,
      value: o.value || 'N/A',
      valueNum: Number(o.valueNum || 0),
      payment: o.payment || 'N/A',
      status: o.status || 'N/A',
      pincode: o.pincode || 'N/A',
      location: o.location || 'N/A',
    }
  }

  get(orderId: number|string): Order|null {
    const e = this.data[String(orderId)]
    if (!e) return null
    return { ...e, source:'cache' }
  }

  set(orderId: number|string, order: Order) {
    this.data[String(orderId)] = this.compact(stripSource(order))
    this.dirty++
    if (this.dirty >= 200) this.flush()
  }

  bulkLoad(orders: Order[], defaultSlug='') {
    let added=0, skipped=0
    orders.forEach(o => {
      const key = String(o.orderId)
      const incoming = this.compact({ ...stripSource(o), slug: o.slug || defaultSlug || this.brandSlug })
      const ex = this.data[key]
      if (ex && this.canTreatAsFinal(ex) && isFinalStatus(incoming.status)) { skipped++; return }
      this.data[key] = incoming
      added++
    })
    this.dirty += added
    return { added, skipped }
  }

  save() { if (this.dirty > 0) this.flush() }

  isFinal(orderId: number|string): boolean {
    const e = this.data[String(orderId)]
    return e ? this.canTreatAsFinal(e) : false
  }

  getRange(fromDate:string,toDate:string):Order[] {
    return Object.values(this.data)
      .filter(entry => entry.dateYMD && entry.dateYMD >= fromDate && entry.dateYMD <= toDate)
      .map(entry => ({ ...entry, source:'cache' as const }))
  }

  stats() {
    const keys = Object.keys(this.data)
    const delivered = keys.filter(k => this.canTreatAsFinal(this.data[k])).length
    return { total: keys.length, delivered, active: keys.length - delivered }
  }

  clear() { this.data = {}; try { localStorage.removeItem(this.key()) } catch {} }

  sizeKB() {
    try { return Math.round(JSON.stringify(this.data).length / 1024) } catch { return 0 }
  }
}


// ── Scanner ───────────────────────────────────────────
// Architecture:
//   - callProxy: raw HTTP, returns 'rl' on any failure
//   - fetchBatch: wraps callProxy, handles RL with escalating cooldowns, never gives up
//   - scanManual / scanRange: burst-rest rhythm with adaptive throttling
//
// KEY: On minnies.shiprocket.co every response belongs to Minnies.
//   null = ID doesn't exist yet (genuine gap or end of orders)
//   'rl' = rate limited (retry)
//   Order = valid order

class Scanner {
  private subdomain:string; private slug:string; private idPrefix:string
  public stopped=false; private rlStreak=0
  private onLog:(m:string,c:string)=>void
  private onProgress:(done:number,total:number,found:number)=>void
  private onOrder:(o:Order)=>void
  private onStats?:(s:Partial<ScanStats>)=>void

  private cache:OrderCache|null=null
  private forceRefresh=false

  constructor(subdomain:string,slug:string,idPrefix:string,
    onLog:(m:string,c:string)=>void,
    onProgress:(done:number,total:number,found:number)=>void,
    onOrder:(o:Order)=>void,
    onStats?:(s:Partial<ScanStats>)=>void,
    cache?:OrderCache,
    forceRefresh?:boolean){
    this.subdomain=subdomain;this.slug=slug;this.idPrefix=idPrefix
    this.onLog=onLog;this.onProgress=onProgress;this.onOrder=onOrder;this.onStats=onStats
    this.cache=cache||null;this.forceRefresh=forceRefresh||false
  }

  stop(){this.stopped=true}
  private toId(n:number):string|number{return this.idPrefix?`${this.idPrefix}${n}`:n}
  static numericPart(id:number|string):number{
    if(typeof id==='number')return id
    const m=String(id).match(/(\d+)$/)
    return m?parseInt(m[1]):0
  }

  // Raw proxy call — returns 'rl' on any failure/rate-limit
  private async callProxy(ids:number[]):Promise<Array<Order|null|'rl'>>{
    try{
      const res=await fetch('/api/proxy',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({subdomain:this.subdomain,ids:ids.map(n=>this.toId(n))})
      })
      if(!res.ok)return ids.map(()=>'rl' as const)
      const{results}=await res.json()
      return results
    }catch{return ids.map(()=>'rl' as const)}
  }

  // Wait with stop-check every 500ms, log countdown every 30s
  private async wait(ms:number,label:string):Promise<void>{
    const start=Date.now()
    this.onLog(label+': '+Math.ceil(ms/1000)+'s...','info')
    let lastLog=0
    for(let elapsed=0;elapsed<ms&&!this.stopped;elapsed=Date.now()-start){
      const remaining=Math.ceil((ms-elapsed)/1000)
      if(elapsed-lastLog>=30000){lastLog=elapsed;this.onLog(label+': '+remaining+'s remaining','info')}
      await sleep(Math.min(500,ms-elapsed))
    }
    if(!this.stopped)this.onLog(label+' done','info')
  }

  // Fetch with infinite retry on RL — escalating cooldowns: 10s,30s,60s,120s,180s,300s
  async fetchBatch(ids:number[]):Promise<Array<Order|null|'rl'>>{
    if(this.stopped)return ids.map(()=>null)
    const WAITS=[10,20,40,60,90,120]
    let attempt=0
    while(!this.stopped){
      const results=await this.callProxy(ids)
      if(results.some(r=>r!=='rl')){
        if(this.rlStreak>0){this.rlStreak=0;this.onLog('Connection restored','ok')}
        return results
      }
      attempt++;this.rlStreak++
      this.onStats?.({retries:1})
      const waitSec=WAITS[Math.min(attempt-1,WAITS.length-1)]
      this.onLog('Rate limited (x'+attempt+') — waiting '+waitSec+'s','info')
      await this.wait(waitSec*1000,'Cooldown')
    }
    return ids.map(()=>null)
  }

  private async probe(id:number):Promise<Order|null|'rl'>{
    const r=await this.callProxy([id]);return r[0]
  }

  // Boundary walk for By Date scan
  async walkToBracket(refId:number,refDate:string,targetDate:string,label:string):Promise<{lo:number,hi:number}>{
    const forward=targetDate>refDate
    let lo=refId,hi=refId,lastId=refId,consNulls=0
    this.onLog(label+': walking '+(forward?'→':'←')+' from #'+this.idPrefix+refId,'info')
    for(let i=1;i<=400&&!this.stopped;i++){
      const pid=forward?refId+i*500:Math.max(1,refId-i*500)
      const o=await this.probe(pid)
      if(o&&o!=='rl'&&o.dateYMD){
        consNulls=0;lastId=Scanner.numericPart(o.orderId)
        this.onLog('  #'+o.orderId+' = '+o.orderDate,'info')
        if(forward){
          if(o.dateYMD>=targetDate){hi=lastId;break}
          lo=lastId
          if((new Date(targetDate+'T00:00:00').getTime()-new Date(o.dateYMD+'T00:00:00').getTime())/86400000<=5){hi=lastId+3000;break}
        }else{
          if(o.dateYMD<targetDate){lo=lastId;break}
          hi=lastId
        }
      }else if(o===null){
        consNulls++
        if(forward&&lo>refId&&consNulls>=4){hi=lastId+1500;break}
      }
      await sleep(60)
      if(!forward&&pid<=1)break
    }
    if(hi<=lo)hi=lo+2000
    return{lo,hi}
  }

  async findBoundaries(anchorId:number,anchorDate:string,regPts:Array<{date:string,id:number}>,fromDate:string,toDate:string):Promise<{scanStart:number,scanEnd:number}>{
    const pts=[{date:anchorDate,id:anchorId},...regPts].filter(p=>p.date&&p.id>0).sort((a,b)=>a.date.localeCompare(b.date))
    const closest=(t:string)=>pts.reduce((b,p)=>
      Math.abs(new Date(p.date+'T00:00:00').getTime()-new Date(t+'T00:00:00').getTime())<
      Math.abs(new Date(b.date+'T00:00:00').getTime()-new Date(t+'T00:00:00').getTime())?p:b,pts[0])
    const rF=closest(fromDate)
    const fromB=await this.walkToBracket(rF.id,rF.date,fromDate,'fromDate')
    if(this.stopped)return{scanStart:0,scanEnd:0}
    const rT=fromB.lo>closest(toDate).id?{id:fromB.lo,date:fromDate}:closest(toDate)
    const toB=await this.walkToBracket(rT.id,rT.date,toDate,'toDate')
    const scanStart=Math.max(1,fromB.lo-100),scanEnd=toB.hi+100
    this.onLog('Range: #'+this.idPrefix+scanStart+' to #'+this.idPrefix+scanEnd+' ('+(scanEnd-scanStart+1)+' IDs)','ok')
    return{scanStart,scanEnd}
  }

  // Adaptive burst controller
  // Starts at BURST_MAX, halves on RL cooldown, recovers slowly
  private static BURST_MAX=80
  private static BURST_MIN=10
  private static REST_BASE=3000  // ms between bursts

  async scanRange(scanStart:number,scanEnd:number,fromDate:string,toDate:string,concurrency:number,startedAt:number):Promise<Order[]>{
    const orders:Order[]=[]
    let scanned=0,matched=0,fromCacheCount=0,burstNum=0
    let burstSize=Scanner.BURST_MAX
    const total=scanEnd-scanStart+1

    for(let base=scanStart;base<=scanEnd&&!this.stopped;){
      const burstEnd=Math.min(base+burstSize-1,scanEnd)
      burstNum++

      // ── Cache check: split IDs into cached-final vs needs-fetch ──
      const toFetch:number[]=[]
      for(let id=base;id<=burstEnd;id++){
        if(!this.forceRefresh&&this.cache?.isFinal(id)){
          // Load from cache — no API call needed
          const cached={...this.cache.get(id)!,source:'cache' as const}
          if(cached.dateYMD&&cached.dateYMD>=fromDate&&cached.dateYMD<=toDate){
            orders.push(cached);matched++;fromCacheCount++;this.onOrder(cached)
            this.onLog('#'+id+'  '+cached.orderDate+'  [cached '+cached.status+']','ok')
          }
          scanned++
        }else{
          toFetch.push(id)
        }
      }

      const cacheHits=burstEnd-base+1-toFetch.length
      if(cacheHits>0)this.onLog('Burst '+burstNum+': '+cacheHits+' from cache, '+toFetch.length+' to fetch','info')
      else this.onLog('Burst '+burstNum+' (sz='+burstSize+'): #'+this.toId(base)+' → #'+this.toId(burstEnd),'info')

      // ── Fetch non-cached IDs ──
      let rlInBurst=0
      for(let b=0;b<toFetch.length&&!this.stopped;b+=concurrency){
        const ids=toFetch.slice(b,b+concurrency)
        const results=await this.fetchBatch(ids)
        for(let i=0;i<ids.length;i++){
          const o=results[i];scanned++
          if(o==='rl'){rlInBurst++;continue}
          if(o!==null){
            const tagged={...o,source:'fresh' as const}
            this.cache?.set(ids[i],tagged)  // save to cache
            if(tagged.dateYMD&&tagged.dateYMD>=fromDate&&tagged.dateYMD<=toDate){
              orders.push(tagged);matched++;this.onOrder(tagged)
              this.onLog('#'+ids[i]+'  '+tagged.orderDate+'  '+tagged.value+'  '+tagged.payment+'  '+tagged.location+'  '+tagged.pincode,'ok')
            }
          }
        }
        this.onProgress(scanStart+scanned-1,scanEnd,matched)
        await sleep(120)
      }

      this.cache?.save()  // flush cache after each burst

      if(rlInBurst>0){burstSize=Math.max(Scanner.BURST_MIN,Math.floor(burstSize/2));this.onLog('Throttling — burst reduced to '+burstSize,'info')}
      else if(burstSize<Scanner.BURST_MAX){burstSize=Math.min(Scanner.BURST_MAX,burstSize+10)}

      base=burstEnd+1
      if(base>scanEnd||this.stopped)break

      const pct=Math.round(scanned/total*100)
      const rest=rlInBurst>0?Scanner.REST_BASE*2:Scanner.REST_BASE
      this.onLog('Rest '+(rest/1000)+'s | '+matched+' found ('+fromCacheCount+' cache) | '+pct+'%','info')
      this.onStats?.({lastMatchedId:matched>0?Scanner.numericPart(orders[orders.length-1].orderId):null})
      for(let t=0;t<rest&&!this.stopped;t+=300)await sleep(Math.min(300,rest-t))
    }
    this.cache?.save()
    return orders
  }

  async scanManual(startId:number,endId:number,concurrency:number,useAuto:boolean,stopAfter:number,startedAt:number):Promise<Order[]>{
    const orders:Order[]=[]
    let scanned=0,matched=0,consNulls=0,burstNum=0
    let lastGoodId:number|null=null
    // Adaptive burst: shrinks on RL, recovers after clean bursts
    let burstSize=Scanner.BURST_MAX
    let cleanBursts=0      // consecutive bursts with no RL
    let rlCooldowns=0      // total RL cooldowns taken (for escalating wait)

    // Check if we're rate-limited by probing a known-good ID 3 times
    // Only declare "genuine end" if ALL 3 probes return a real order
    const isRateLimited=async():Promise<boolean>=>{
      if(!lastGoodId)return false
      this.onLog('Verifying x3 on #'+this.toId(lastGoodId)+'...','info')
      let successCount=0
      for(let i=0;i<3;i++){
        const r=(await this.callProxy([lastGoodId]))[0]
        if(r&&r!=='rl'&&r!==null)successCount++
        await sleep(2000)
      }
      const rl=successCount<3  // rate limited if ANY probe fails
      this.onLog(rl?'Rate limited ('+successCount+'/3 probes succeeded)':'All 3 probes OK — genuine end','info')
      return rl
    }

    for(let base=startId;base<=endId&&!this.stopped;){
      const burstEnd=Math.min(base+burstSize-1,endId)
      burstNum++
      this.onLog('Burst '+burstNum+' (sz='+burstSize+'): #'+this.toId(base)+' → #'+this.toId(burstEnd),'info')

      // Cache check for manual scan
      const toFetchM:number[]=[]
      for(let id=base;id<=burstEnd;id++){
        if(!this.forceRefresh&&this.cache?.isFinal(id)){
          const cached={...this.cache.get(id)!,source:'cache' as const}
          orders.push(cached);matched++;consNulls=0
          lastGoodId=id;this.onOrder(cached)
          this.onLog('#'+id+'  '+cached.orderDate+'  [cached '+cached.status+']','ok')
          scanned++
        }else toFetchM.push(id)
      }

      let rlInBurst=0
      for(let b=0;b<toFetchM.length&&!this.stopped;b+=concurrency){
        const ids=toFetchM.slice(b,b+concurrency)
        const results=await this.fetchBatch(ids)

        for(let i=0;i<ids.length&&!this.stopped;i++){
          const o=results[i];scanned++
          if(o==='rl'){rlInBurst++;continue}
          if(o!==null){
            const fo={...o,source:'fresh' as const}
            this.cache?.set(ids[i],fo)
            orders.push(fo);matched++;consNulls=0;cleanBursts=0
            lastGoodId=ids[i]
            this.onStats?.({lastMatchedId:Scanner.numericPart(fo.orderId)})
            this.onOrder(fo)
            this.onLog('#'+ids[i]+'  '+fo.orderDate+'  '+fo.value+'  '+fo.payment+'  '+fo.location,'ok')
          }else{
            consNulls++
            // Reached null threshold — check if rate-limited before stopping/waiting
            if(useAuto&&consNulls>=stopAfter){
              const rl=await isRateLimited()
              if(!rl){
                // Genuine end
                this.onLog('Genuine end of orders after '+matched+' orders','ok')
                this.stopped=true
                break
              }
              // Rate limited — escalating cooldown
              rlCooldowns++
              cleanBursts=0
              // Cooldown escalates: 120s, 180s, 300s, 300s, ...
              const coolSec=[30,60,90,180,300][Math.min(rlCooldowns-1,4)]
              this.onLog('Rate-limit cooldown #'+rlCooldowns+' — waiting '+coolSec+'s then resuming...','info')
              await this.wait(coolSec*1000,'Cooldown')
              if(this.stopped)break
              // After cooldown: shrink burst size and reset null counter
              burstSize=Math.max(Scanner.BURST_MIN,Math.floor(burstSize/2))
              consNulls=0
              this.onLog('Resuming with smaller bursts (sz='+burstSize+')','ok')
            }
          }
        }
        this.onProgress(startId+scanned-1,endId,matched)
        await sleep(120)
      }

      // Adapt burst size based on this burst's health
      if(rlInBurst>0){
        burstSize=Math.max(Scanner.BURST_MIN,Math.floor(burstSize/2))
        cleanBursts=0
        this.onLog('RL in burst — reduced size to '+burstSize,'info')
      }else{
        cleanBursts++
        if(cleanBursts>=3&&burstSize<Scanner.BURST_MAX){
          burstSize=Math.min(Scanner.BURST_MAX,burstSize+20)
          this.onLog('Clean burst streak — increased size to '+burstSize,'info')
        }
      }

      base=burstEnd+1
      if(base>endId||this.stopped)break

      // Longer rest after RL cooldowns to let rate limit fully reset
      const rest=rlCooldowns>0?Scanner.REST_BASE*2:Scanner.REST_BASE
      this.cache?.save()
      this.onLog('Rest '+(rest/1000)+'s — burst '+burstNum+' | '+matched+' found | '+consNulls+' null streak','info')
      this.onStats?.({retries:this.rlStreak})
      for(let t=0;t<rest&&!this.stopped;t+=300)await sleep(Math.min(300,rest-t))
    }
    this.cache?.save()
    return orders
  }
}


// ── App ───────────────────────────────────────────────
export default function App(){
  const[light,setLight]=useState(false)
  const[brands,setBrands]=useState<Brand[]>([])
  const[active,setActive]=useState<Brand|null>(null)
  const[tab,setTab]=useState<'date'|'manual'|'analytics'|'compare'|'history'|'settings'>('date')
  const[runs,setRuns]=useState<Run[]>([])
  const[lastOrders,setLastOrders]=useState<Order[]>([])
  const[analytics,setAnalytics]=useState<Analytics|null>(null)
  const[scanning,setScanning]=useState(false)
  const[log,setLog]=useState<Array<{msg:string,cls:string}>>([{msg:'Select a date range and click Find & Scrape.',cls:''}])
  const[progress,setProgress]=useState({done:0,total:0,found:0})
  const[scanStats,setScanStats]=useState<ScanStats>({retries:0,recovered:0,duplicates:0,gapJumps:0,lastMatchedId:null})
  const[startedAt,setStartedAt]=useState(0)
  const[scanLabel,setScanLabel]=useState('')
  const[forceRefresh,setForceRefresh]=useState(false)
  const[showAdd,setShowAdd]=useState(false)
  const scannerRef=useRef<Scanner|null>(null)
  const logRef=useRef<HTMLDivElement>(null)
  const ordersRef=useRef<Order[]>([])
  const rateWindow=useRef<Array<{t:number,done:number}>>([])
  const vars=light?lightVars:darkVars
  const inp:any={width:'100%',padding:'8px 10px',fontSize:12,background:'var(--surface)',border:'1px solid var(--border)',color:'var(--text)',borderRadius:6,fontFamily:'inherit',outline:'none'}
  const lbl:any={fontSize:9,color:'var(--muted)',letterSpacing:'.08em',textTransform:'uppercase',display:'block',marginBottom:4}

  useEffect(()=>{const l=LS.get('lightMode',false);setLight(l);const bs=LS.get<Brand[]>('brands',[]);setBrands(bs);const aid=LS.get('activeBrandId','');const b=bs.find((x:Brand)=>x.id===aid)||bs[0]||null;if(b){setActive(b);loadRuns(b)}},[])
  useEffect(()=>{if(logRef.current)logRef.current.scrollTop=logRef.current.scrollHeight},[log])
  useEffect(()=>{const fn=()=>{if(document.hidden&&scanning)addLog('⚠ Tab hidden — scan may slow. Keep this tab active!','err')};document.addEventListener('visibilitychange',fn);return()=>document.removeEventListener('visibilitychange',fn)},[scanning])

  // Auto-send morning Telegram report once per day on app open
  useEffect(()=>{
    const tgToken=LS.get('tg_token','');const tgChat=LS.get('tg_chat','');const tgBrand=LS.get('tg_brand','')
    if(!tgToken||!tgChat||!tgBrand)return
    const now=new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Kolkata'}))
    const today=now.toISOString().split('T')[0]
    const lastSent=LS.get('tg_last_sent','')
    if(lastSent===today)return  // already sent today
    if(now.getHours()<7||now.getHours()>10)return  // only auto-send 7-10 AM IST
    const brand=LS.get<Brand[]>('brands',[]).find(b=>b.id===tgBrand||b.name===tgBrand)
    if(!brand)return
    const runs=LS.get<Run[]>(`runs_${brand.id}`,[])
    if(!runs.length)return
    const allOrders=runs.flatMap(r=>r.orders||[])
    const yest=new Date(now.getTime()-86400000).toISOString().split('T')[0]
    const dow=now.getDay()||7;const wStart=new Date(now.getTime()-(dow-1)*86400000).toISOString().split('T')[0]
    const mStart=today.slice(0,7)+'-01'
    const msg=buildTelegramReport(allOrders,brand.name,'',yest,wStart,mStart,today)
    sendTelegramMsg(tgToken,tgChat,msg).then(()=>{
      LS.set('tg_last_sent',today)
      // Send yesterday's CSV
      const yestOrders=allOrders.filter(o=>o.dateYMD===yest)
      if(yestOrders.length>0){
        const csv='Order ID,Date,Time,Value,Payment,Status,Location,Pincode,Source\n'+
          yestOrders.map(o=>`${o.orderId},${o.orderDate},${o.orderTime},${o.value},${o.payment},${o.status},${o.location},${o.pincode},${o.source||"fresh"}`).join('\n')
        sendTelegramDoc(tgToken,tgChat,`${brand.name}_${yest}.csv`,csv,`Yesterday's orders — ${brand.name}`)
      }
    }).catch(()=>{})
  },[])

  const addLog=useCallback((msg:string,cls:string='')=>setLog(p=>[...p.slice(-400),{msg,cls}]),[])

  function loadRuns(b:Brand){const r=LS.get<Run[]>(`runs_${b.id}`,[]);setRuns(r);if(r.length>0){setLastOrders(r[0].orders);setAnalytics(buildAnalytics(r[0].orders))}else{setLastOrders([]);setAnalytics(null)}}
  function selectBrand(b:Brand){setActive(b);LS.set('activeBrandId',b.id);loadRuns(b)}
  function deleteBrand(id:string){if(!confirm('Delete this brand and all data?'))return;const u=brands.filter(b=>b.id!==id);setBrands(u);LS.set('brands',u);localStorage.removeItem(`runs_${id}`);const n=u[0]||null;setActive(n);if(n)loadRuns(n);else{setRuns([]);setLastOrders([]);setAnalytics(null)}}

  function saveRun(brand:Brand,orders:Order[],label:string){
    const cleaned=uniqueOrders(orders)
    if(!cleaned.length)return
    // Persist to cache — ensures cache is always up to date after every scan
    const scanCache=new OrderCache(brand.id, brand.slug||brand.subdomain)
    scanCache.bulkLoad(cleaned,brand.slug||brand.subdomain)
    scanCache.save()
    const run:Run={runId:Date.now().toString(),dateRange:label,found:cleaned.length,orders:cleaned,createdAt:new Date().toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'})}
    const updated=[run,...LS.get<Run[]>(`runs_${brand.id}`,[])].slice(0,50)
    LS.set(`runs_${brand.id}`,updated);setRuns(updated);setLastOrders(cleaned);setAnalytics(buildAnalytics(cleaned))
    const toNum=(id:number|string)=>typeof id==='number'?id:parseInt(String(id).replace(/[^0-9]/g,''))||0
    const byDate:Record<string,{min:number,max:number}>={}
    cleaned.forEach(o=>{if(!o.dateYMD)return;const n=toNum(o.orderId);if(!byDate[o.dateYMD])byDate[o.dateYMD]={min:n,max:n};else{byDate[o.dateYMD].min=Math.min(byDate[o.dateYMD].min,n);byDate[o.dateYMD].max=Math.max(byDate[o.dateYMD].max,n)}})
    const newPts=Object.entries(byDate).map(([date,{min,max}])=>({date,id:Math.round((min+max)/2)}))
    const merged=Object.values(Object.fromEntries([...(brand.regressionPoints||[]),...newPts].map(p=>[p.date,p]))).sort((a:any,b:any)=>a.date.localeCompare(b.date)) as Array<{date:string,id:number}>
    let newAvg=brand.avgPerDay
    if(merged.length>=2){const f=merged[0],l=merged[merged.length-1];const days=(new Date(l.date+' 00:00:00').getTime()-new Date(f.date+' 00:00:00').getTime())/86400000;if(days>0)newAvg=Math.min(2000,Math.max(1,Math.ceil((l.id-f.id)/days)))}
    const u2={...brand,regressionPoints:merged.slice(-30),avgPerDay:newAvg}
    setActive(u2);setBrands(brands.map(b=>b.id===brand.id?u2:b));LS.set('brands',brands.map(b=>b.id===brand.id?u2:b))
    const url=LS.get(`sheets_${brand.id}`,'')
    if(url&&cleaned.length>0)syncToSheets(url,cleaned).then(n=>n>0&&addLog(`✓ Sheets: ${n} rows synced`,'ok'))

    // POST run data to server so Vercel Cron can access it for daily report
    const allRuns=LS.get<Run[]>(`runs_${brand.id}`,[])
    fetch('/api/run-store',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({subdomain:brand.subdomain,runs:allRuns.slice(0,15)})}).catch(()=>{})

    // Send Telegram scan-complete notification if configured for this brand
    const tgToken=LS.get('tg_token','');const tgChat=LS.get('tg_chat','');const tgBrand=LS.get('tg_brand','')
    if(tgToken&&tgChat&&(!tgBrand||tgBrand===brand.id)){
      const rev=cleaned.reduce((s,o)=>s+(o.valueNum||0),0)
      const cod=cleaned.filter(o=>(o.payment||'').toUpperCase()==='COD').length
      const msg=[`✅ <b>Scan Done</b> — ${brand.name}`,`📅 ${label}`,
        `📦 ${cleaned.length} orders`].join('\n')
      sendTelegramMsg(tgToken,tgChat,msg).catch(()=>{})
    }
  }

  function importOrdersToBrand(brand:Brand, importedOrders:Order[], sourceLabel:string){
    const cleaned=mergeOrdersById(importedOrders.map(order=>({
      ...order,
      slug: order.slug || brand.slug || brand.subdomain,
      source: order.source || 'cache',
    })))
    if(!cleaned.length)return
    const cache=new OrderCache(brand.id, brand.slug||brand.subdomain)
    cache.bulkLoad(cleaned,brand.slug||brand.subdomain)
    cache.save()
    const dates=cleaned.map(order=>order.dateYMD).filter(Boolean).sort() as string[]
    const label=dates.length===0?sourceLabel:dates[0]===dates[dates.length-1]?dates[0]:`${dates[0]} to ${dates[dates.length-1]}`
    const run:Run={runId:'import_'+Date.now(),dateRange:label,found:cleaned.length,orders:cleaned,createdAt:'Imported'}
    const updated=[run,...LS.get<Run[]>(`runs_${brand.id}`,[]).filter(existing=>existing.runId!==run.runId)].slice(0,50)
    LS.set(`runs_${brand.id}`,updated)
    setRuns(updated)
    setLastOrders(cleaned)
    setAnalytics(buildAnalytics(cleaned))
  }

  async function syncToSheets(url:string,orders:Order[]):Promise<number>{
    let added=0
    for(let i=0;i<orders.length;i+=200){
      try{const res=await fetch(url,{method:'POST',headers:{'Content-Type':'text/plain'},body:JSON.stringify({orders:orders.slice(i,i+200),mode:i===0?'append':'append'})});const d=await res.json();if(d.ok)added+=d.added||0}catch{}
      await sleep(500)
    }
    return added
  }

  function calcETA(done:number,total:number,sat:number):string{
    if(!total||!done)return''
    const now=Date.now()
    rateWindow.current=[...rateWindow.current.filter(p=>now-p.t<30000),{t:now,done}]
    const w=rateWindow.current;let rate=0
    if(w.length>=2){const o=w[0],n=w[w.length-1];const el=(n.t-o.t)/1000;if(el>0)rate=(n.done-o.done)/el}
    if(!rate&&done>0)rate=done/((now-sat)/1000)
    if(!rate)return''
    const rem=(total-done)/rate
    if(rem>=3600)return`${Math.floor(rem/3600)}h ${Math.floor((rem%3600)/60)}m`
    if(rem>=60)return`${Math.floor(rem/60)}m ${Math.floor(rem%60)}s`
    return`${Math.floor(rem)}s`
  }
  const eta=calcETA(progress.done,progress.total,startedAt)
  const pct=progress.total?Math.min(progress.done/progress.total*100,100):0

  async function startDateScan(fromDate:string,toDate:string,concurrency:number){
    if(!active||scanning)return
    const brand=active
    setScanning(true);setLog([]);ordersRef.current=[];rateWindow.current=[]
    setScanStats({retries:0,recovered:0,duplicates:0,gapJumps:0,lastMatchedId:null})
    setProgress({done:0,total:0,found:0});setStartedAt(Date.now());setScanLabel(`${fromDate} → ${toDate}`)
    if('wakeLock' in navigator){try{(navigator as any).wakeLock.request('screen').catch(()=>{})}catch{}}
    addLog('⚠ Keep this tab active — switching tabs may pause the scan','info')
    const cache=new OrderCache(brand.id, brand.slug||brand.subdomain)
    const cs=cache.stats()
    if(cs.total>0&&!forceRefresh)addLog(`Cache: ${cs.delivered} delivered (skip) + ${cs.active} active (rescan) — ${cache.sizeKB()}KB`,'ok')
    if(forceRefresh)addLog('Force refresh: ignoring all cache','info')
    const scanner=new Scanner(brand.subdomain,brand.slug,brand.idPrefix||'',addLog,(done,total,found)=>{setProgress({done,total,found});rateWindow.current=[...rateWindow.current,{t:Date.now(),done}]},(o)=>{ordersRef.current=[...ordersRef.current,o]},(s)=>setScanStats(p=>mergeScanStats(p,s)),cache,forceRefresh)
    scannerRef.current=scanner
    try{
      addLog(`Finding boundaries for ${fromDate} → ${toDate}...`,'info')
      const{scanStart,scanEnd}=await scanner.findBoundaries(brand.anchorId,brand.anchorDate,brand.regressionPoints||[],fromDate,toDate)
      if(scanner['stopped']){if(ordersRef.current.length>0){const o=ordersRef.current;const dates=o.map(r=>r.dateYMD).filter(Boolean).sort();saveRun(brand,o,`${dates[0]} to ${dates[dates.length-1]} (partial)`);addLog(`Saved ${o.length} partial orders`,'info')}; return}
      setProgress({done:0,total:scanEnd-scanStart+1,found:0});const sa2=Date.now();setStartedAt(sa2)
      const scannedOrders=await scanner.scanRange(scanStart,scanEnd,fromDate,toDate,concurrency,sa2)
      const orders=buildUnifiedRangeOrders(cache,scannedOrders,fromDate,toDate,forceRefresh)
      const cacheLoaded=orders.filter(o=>o.source==='cache').length
      const freshLoaded=orders.length-cacheLoaded
      addLog(`Unified result: ${orders.length} orders (${cacheLoaded} cache + ${freshLoaded} fresh)`,'ok')
      const dates=orders.map(r=>r.dateYMD).filter(Boolean).sort()
      const label=dates.length===0?`${fromDate} to ${toDate}`:dates[0]===dates[dates.length-1]?dates[0]!:`${dates[0]} to ${dates[dates.length-1]}`
      saveRun(brand,orders,label)
      addLog(`✓ Done: ${label} — ${orders.length} orders`,'ok')
    }catch(e:any){
      addLog('Error: '+e.message,'err')
      if(ordersRef.current.length>0){const o=ordersRef.current;const dates=o.map(r=>r.dateYMD).filter(Boolean).sort();saveRun(brand,o,dates.length<2?'partial':`${dates[0]} to ${dates[dates.length-1]} (partial)`);addLog(`Saved ${o.length} orders`,'info')}
    }finally{setScanning(false);setScanLabel('')}
  }

  async function startManualScan(startId:number,endId:number,concurrency:number,useAuto:boolean,stopAfter:number){
    if(!active||scanning)return
    if(!Number.isFinite(startId)||startId<=0){addLog('Invalid start ID. Please enter a real numeric Shiprocket order ID.','err');return}
    const brand=active
    const safeStopAfter=useAuto?Math.max(stopAfter,recommendedAutoStop(concurrency,brand.avgPerDay||0)):stopAfter
    const autoHardCap=startId+Math.max(20000,Math.min(250000,(brand.avgPerDay||0)*45))
    setScanning(true);setLog([]);ordersRef.current=[];rateWindow.current=[]
    setScanStats({retries:0,recovered:0,duplicates:0,gapJumps:0,lastMatchedId:null})
    setProgress({done:0,total:useAuto?0:endId-startId+1,found:0});const sa=Date.now();setStartedAt(sa);setScanLabel(`#${brand.idPrefix||''}${startId}–${useAuto?'auto':'#'+(brand.idPrefix||'')+endId}`)
    addLog(`Manual: #${brand.idPrefix||''}${startId}–${useAuto?'auto':'#'+(brand.idPrefix||'')+endId} | ${concurrency}x`,'info')
    if(useAuto&&safeStopAfter!==stopAfter)addLog(`Raised auto-stop from ${stopAfter} to ${safeStopAfter} for safer scanning`,'info')
    if(useAuto)addLog(`Auto hard cap set to #${brand.idPrefix||''}${autoHardCap} based on current brand velocity`,'info')
    const cacheM=new OrderCache(brand.id, brand.slug||brand.subdomain)
    const csM=cacheM.stats()
    if(csM.total>0&&!forceRefresh)addLog(`Cache: ${csM.delivered} delivered (skip) + ${csM.active} active | ${cacheM.sizeKB()}KB`,'ok')
    const scanner=new Scanner(brand.subdomain,brand.slug,brand.idPrefix||'',addLog,(done,total,found)=>{setProgress({done,total,found});rateWindow.current=[...rateWindow.current,{t:Date.now(),done}]},(o)=>{ordersRef.current=[...ordersRef.current,o]},(s)=>setScanStats(p=>mergeScanStats(p,s)),cacheM,forceRefresh)
    scannerRef.current=scanner
    try{
      const maxId=useAuto?autoHardCap:endId
      const orders=await scanner.scanManual(startId,maxId,concurrency,useAuto,safeStopAfter,sa)
      const dates=orders.map(r=>r.dateYMD).filter(Boolean).sort()
      const label=dates.length<2?'manual':`${dates[0]} to ${dates[dates.length-1]}`
      if(orders.length>0){const highest=Math.max(...orders.map(o=>parseInt(String(o.orderId).replace(/[^0-9]/g,''))||0));LS.set(`manual_resume_${brand.id}`,highest+1)}
      if(orders.length>0)saveRun(brand,orders,label)
      addLog(`✓ Done: ${label} — ${orders.length} orders`,'ok')
    }catch(e:any){
      addLog('Error: '+e.message,'err')
      if(ordersRef.current.length>0){saveRun(brand,ordersRef.current,'manual (partial)');addLog(`Saved ${ordersRef.current.length} orders`,'info')}
    }finally{setScanning(false);setScanLabel('')}
  }

  function stopScan(){
    scannerRef.current?.stop();setScanning(false);addLog('Stopping...','info')
    if(ordersRef.current.length>0&&active){const o=ordersRef.current;const dates=o.map(r=>r.dateYMD).filter(Boolean).sort();const label=dates.length<2?'partial':`${dates[0]} to ${dates[dates.length-1]} (partial)`;saveRun(active,o,label);addLog(`Saved ${o.length} orders`,'ok')}
  }

  return(
    <div style={{...(vars as any),background:'var(--bg)',color:'var(--text)',minHeight:'100vh',fontFamily:"'JetBrains Mono','Fira Code','Courier New',monospace",transition:'background .2s'}}>
    <div style={{maxWidth:960,margin:'0 auto',padding:'20px 16px'}}>

      {/* Header */}
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:18}}>
        <div><div style={{fontSize:13,fontWeight:700,letterSpacing:'.1em',color:'var(--accent)',textTransform:'uppercase'}}>Shiprocket Order Scrapper</div><div style={{fontSize:9,color:'var(--muted)',marginTop:2}}>by RahulJ · PRO v6.0 · Free Web Edition</div></div>
        <div style={{display:'flex',gap:8}}>
          <button onClick={()=>{const n=!light;setLight(n);LS.set('lightMode',n)}} style={{background:'var(--surface)',border:'1px solid var(--border)',color:'var(--text)',width:32,height:32,borderRadius:6,fontSize:15,cursor:'pointer',fontFamily:'inherit'}}>{light?'🌙':'☀️'}</button>
          <button onClick={()=>setShowAdd(true)} style={{background:'var(--accent)',color:'#000',border:'none',padding:'7px 14px',borderRadius:6,fontSize:11,fontWeight:700,cursor:'pointer',fontFamily:'inherit'}}>+ ADD BRAND</button>
        </div>
      </div>

      {/* Brand selector */}
      {brands.length>0&&(
        <div style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:8,padding:'8px 12px',marginBottom:12,display:'flex',alignItems:'center',gap:10}}>
          <span style={{fontSize:9,color:'var(--muted)',letterSpacing:'.08em',textTransform:'uppercase',flexShrink:0}}>Brand</span>
          <select value={active?.id||''} onChange={e=>{const b=brands.find(x=>x.id===e.target.value);if(b)selectBrand(b)}} style={{flex:1,border:'none',background:'transparent',color:'var(--text)',fontSize:13,fontWeight:700,padding:'2px 0',outline:'none',fontFamily:'inherit'}}>
            {brands.map(b=><option key={b.id} value={b.id} style={{background:'var(--surface)'}}>{b.name} ({b.subdomain}.shiprocket.co)</option>)}
          </select>
          <span style={{fontSize:9,color:'var(--muted)',flexShrink:0}}>~{active?.avgPerDay}/day · {active?.regressionPoints?.length||0} cal pts</span>
        </div>
      )}

      {brands.length===0&&!showAdd&&(
        <div style={{textAlign:'center',padding:'60px 20px',color:'var(--muted)'}}>
          <div style={{fontSize:32,marginBottom:16}}>📦</div>
          <div style={{fontSize:13,marginBottom:8}}>No brands added yet</div>
          <div style={{fontSize:11,lineHeight:2}}>Click <span style={{color:'var(--accent)'}}>+ ADD BRAND</span> to get started</div>
        </div>
      )}

      {showAdd&&<AddBrandForm onAdd={(brand:Brand)=>{const u=[...brands,brand];setBrands(u);LS.set('brands',u);selectBrand(brand);setShowAdd(false)}} onCancel={()=>setShowAdd(false)} inp={inp} lbl={lbl}/>}

      {active&&!showAdd&&(
        <>
          <DashboardStrip runs={runs}/>
          <div style={{display:'flex',borderBottom:'1px solid var(--border)',marginBottom:16,overflowX:'auto'}}>
            {(['date','manual','analytics','compare','history','settings'] as const).map(t=>(
              <button key={t} onClick={()=>setTab(t)} style={{background:'none',border:'none',borderBottom:`2px solid ${tab===t?'var(--accent)':'transparent'}`,color:tab===t?'var(--accent)':'var(--muted)',fontSize:10,fontWeight:700,letterSpacing:'.08em',textTransform:'uppercase',padding:'8px 14px',cursor:'pointer',marginBottom:-1,whiteSpace:'nowrap',fontFamily:'inherit'}}>
                {t==='date'?'By Date':t==='compare'?'Compare':t.charAt(0).toUpperCase()+t.slice(1)}
              </button>
            ))}
          </div>

          {(tab==='date'||tab==='manual')&&(
            <>
              {tab==='date'&&<DateTab active={active} scanning={scanning} scanLabel={scanLabel} onStart={(f:string,t:string,c:number)=>startDateScan(f,t,c)} inp={inp} lbl={lbl} forceRefresh={forceRefresh} setForceRefresh={setForceRefresh}/>}
              {tab==='manual'&&<ManualTab active={active} scanning={scanning} scanLabel={scanLabel} onStart={(si:number,ei:number,c:number,ua:boolean,sa:number)=>startManualScan(si,ei,c,ua,sa)} inp={inp} lbl={lbl} forceRefresh={forceRefresh} setForceRefresh={setForceRefresh}/>}
              {scanning&&(
                <div style={{marginBottom:10}}>
                  <div style={{display:'flex',justifyContent:'space-between',fontSize:10,color:'var(--muted)',marginBottom:5}}>
                    <span>{progress.done.toLocaleString()} / {progress.total?progress.total.toLocaleString():'?'} — <b style={{color:'var(--accent)'}}>{progress.found} found</b></span>
                    <span style={{color:'var(--accent)'}}>{eta?`ETA: ${eta}`:''}</span>
                  </div>
                  <div style={{display:'flex',gap:10,flexWrap:'wrap',fontSize:9,color:'var(--muted)',marginBottom:6}}>
                    <span>Retries: <b style={{color:'var(--accent)'}}>{scanStats.retries}</b></span>
                    <span>Recovered: <b style={{color:'var(--accent)'}}>{scanStats.recovered}</b></span>
                    <span>Gap jumps: <b style={{color:'var(--accent)'}}>{scanStats.gapJumps}</b></span>
                    <span>Duplicates skipped: <b style={{color:'var(--accent)'}}>{scanStats.duplicates}</b></span>
                    {scanStats.lastMatchedId&&<span>Last live ID: <b style={{color:'var(--accent)'}}>#{active?.idPrefix||''}{scanStats.lastMatchedId}</b></span>}
                  </div>
                  <div style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:4,height:6,overflow:'hidden'}}>
                    <div style={{height:'100%',background:'var(--accent)',width:`${pct.toFixed(1)}%`,transition:'width .3s',borderRadius:4}}/>
                  </div>
                </div>
              )}
              {scanning&&<button onClick={stopScan} style={{width:'100%',background:'var(--surface)',color:'var(--red)',border:'1px solid var(--red)',padding:10,borderRadius:8,fontSize:11,fontWeight:700,marginBottom:12,fontFamily:'inherit',cursor:'pointer'}}>■ STOP (saves results found so far)</button>}
              <div ref={logRef} style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:6,padding:10,minHeight:80,maxHeight:240,overflowY:'auto',fontSize:10,lineHeight:1.8,marginBottom:12}}>
                {log.map((l,i)=><div key={i} style={{color:l.cls==='ok'?'var(--accent)':l.cls==='err'?'var(--red)':l.cls==='info'?'var(--warn)':'var(--muted)'}}>{l.msg}</div>)}
              </div>
              {lastOrders.length>0&&!scanning&&(
                <div style={{display:'flex',gap:8}}>
                  <button onClick={()=>dlFile(buildCSV(lastOrders),`${active.name}_export.csv`)} style={{flex:1,background:'var(--surface)',border:'1px solid var(--border)',color:'var(--text)',padding:9,borderRadius:6,fontSize:11,fontWeight:700,fontFamily:'inherit',cursor:'pointer'}}>↓ CSV ({lastOrders.length})</button>
                  <button onClick={()=>dlFile(buildReport(lastOrders,active.name,scanLabel||'export'),`${active.name}_report.csv`)} style={{flex:1,background:'var(--surface)',border:'1px solid var(--border)',color:'var(--text)',padding:9,borderRadius:6,fontSize:11,fontWeight:700,fontFamily:'inherit',cursor:'pointer'}}>↓ Full Report</button>
                  <button onClick={()=>navigator.clipboard.writeText(buildWhatsappSummary(lastOrders,active.name,scanLabel||'export')).then(()=>addLog('WA summary copied!','ok'))} style={{flex:1,background:'var(--surface)',border:'1px solid #25d366',color:'#25d366',padding:9,borderRadius:6,fontSize:11,fontWeight:700,fontFamily:'inherit',cursor:'pointer'}}>📱 WA</button>
                </div>
              )}
            </>
          )}
          {tab==='analytics'&&<AnalyticsTab analytics={analytics}/>}
          {tab==='compare'&&<CompareTab brands={brands}/>}
          {tab==='history'&&<HistoryTab runs={runs} brandName={active.name} onClear={()=>{localStorage.removeItem(`runs_${active.id}`);setRuns([]);setLastOrders([]);setAnalytics(null)}}/>}
          {tab==='settings'&&<SettingsTab brands={brands} active={active} runs={runs} onDelete={deleteBrand} onSync={(url:string,orders:Order[])=>syncToSheets(url,orders)} onImportOrders={(orders:Order[], label:string)=>active&&importOrdersToBrand(active,orders,label)} inp={inp} lbl={lbl} forceRefresh={forceRefresh} setForceRefresh={setForceRefresh}/>}
        </>
      )}
    </div>
    </div>
  )
}

function AddBrandForm({onAdd,onCancel,inp,lbl}:any){
  const[url,setUrl]=useState('');const[name,setName]=useState('');const[sub,setSub]=useState('')
  const[oid,setOid]=useState('');const[date,setDate]=useState('');const[status,setStatus]=useState<{msg:string,ok:boolean}|null>(null);const[loading,setLoading]=useState(false)
  function handleUrl(v:string){setUrl(v);const m=v.match(/https?:\/\/([^.]+)\.shiprocket\.co/);if(m){setSub(m[1]);if(!name)setName(m[1].charAt(0).toUpperCase()+m[1].slice(1))}}
  const normalizeDateInput=(v:string)=>{
    if(/^\d{4}-\d{2}-\d{2}$/.test(v))return v
    const m=v.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/)
    return m?`${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`:v
  }
  async function fetchKnownOrder(currentSub:string,currentOid:string){
    for(let attempt=0;attempt<3;attempt++){
      const res=await fetch('/api/proxy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subdomain:currentSub,ids:[currentOid.trim()]})})
      const{results}=await res.json();const o=results[0]
      if(o&&o!=='rl')return o
      await sleep(500*(attempt+1))
    }
    const debugRes=await fetch('/api/debug',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subdomain:currentSub,orderId:currentOid.trim()})})
    const dbg=await debugRes.json()
    if(dbg?.pageSlug)return{slug:dbg.pageSlug,companyName:name||currentSub,orderDate:dbg.pageOrderDate||'N/A'}
    return null
  }
  async function add(){
    if(!name||!sub||!oid||!date){setStatus({msg:'Fill all fields',ok:false});return}
    setLoading(true);setStatus(null)
    try{
      const normalizedDate=normalizeDateInput(date)
      const o=await fetchKnownOrder(sub,oid)
      if(!o){setStatus({msg:'Cannot fetch that order right now. Shiprocket may be throttling. Try again in 30-60s or use another recent known order.',ok:false});setLoading(false);return}
      const prefixMatch=oid.trim().match(/^([A-Za-z]+)/)
      const detectedPrefix=prefixMatch?prefixMatch[1].toUpperCase():''
      const numericBase=normalizeId(oid)
      const probeIds=Array.from({length:30},(_,i)=>detectedPrefix?`${detectedPrefix}${numericBase+i+1}`:numericBase+i+1)
      const probeRes=await fetch('/api/proxy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subdomain:sub,ids:probeIds})})
      const{results:pr}=await probeRes.json()
      const found=pr.filter((r:any)=>r&&r!=='rl'&&r.slug===o.slug)
      const avgPerDay=found.length>0?Math.min(2000,Math.max(5,Math.round((found.length/30)*2000))):30
      onAdd({id:Date.now().toString(),name,subdomain:sub,slug:o.slug,companyName:o.companyName||name,anchorId:numericBase,anchorDate:normalizedDate,avgPerDay,regressionPoints:[],idPrefix:detectedPrefix})
    }catch(e:any){setStatus({msg:e.message,ok:false})}
    setLoading(false)
  }
  return(
    <div style={{background:'var(--surface)',border:'1px solid var(--accent)',borderRadius:10,padding:20,marginBottom:16}}>
      <div style={{fontSize:11,fontWeight:700,color:'var(--accent)',letterSpacing:'.08em',textTransform:'uppercase',marginBottom:14}}>+ Add New Brand</div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8,marginBottom:14,fontSize:9}}>
        {['1. Paste URL','2. Verify one live order','3. Save calibrated brand'].map(step=><div key={step} style={{background:'var(--surface2)',border:'1px solid var(--border)',borderRadius:6,padding:'8px 10px',color:'var(--muted)'}}>{step}</div>)}
      </div>
      <div style={{display:'grid',gap:10}}>
        <div><label style={lbl}>Shiprocket URL (auto-fills subdomain)</label><input value={url} onChange={e=>handleUrl(e.target.value)} placeholder="https://everlasting.shiprocket.co/" style={inp}/></div>
        <div style={{background:'var(--surface2)',border:'1px solid var(--border)',borderRadius:6,padding:'8px 10px',fontSize:9,color:'var(--warn)',lineHeight:1.8}}>⚠ Use <b>order ID</b> from Shiprocket dashboard — NOT the courier tracking ID.<br/>Tip: choose a recent known order so calibration finds nearby orders faster.</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
          <div><label style={lbl}>Brand Name</label><input value={name} onChange={e=>setName(e.target.value)} placeholder="e.g. Everlasting" style={inp}/></div>
          <div><label style={lbl}>Subdomain</label><input value={sub} onChange={e=>setSub(e.target.value)} placeholder="e.g. everlasting" style={inp}/></div>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
          <div><label style={lbl}>One Known Order ID</label><input type="text" value={oid} onChange={e=>setOid(e.target.value)} placeholder="e.g. 437470 or KYT47000" style={inp}/></div>
          <div><label style={lbl}>That Order's Date</label><input type="date" value={date} onChange={e=>setDate(normalizeDateInput(e.target.value))} style={inp}/></div>
        </div>
        {status&&<div style={{padding:'8px 10px',borderRadius:6,fontSize:11,background:status.ok?'#00ff8815':'#ff444415',border:`1px solid ${status.ok?'var(--accent)':'var(--red)'}`,color:status.ok?'var(--accent)':'var(--red)'}}>{status.msg}</div>}
        <div style={{display:'flex',gap:8}}>
          <button onClick={add} disabled={loading} style={{flex:2,padding:9,borderRadius:6,background:'var(--accent)',border:'none',color:'#000',fontSize:11,fontWeight:700,fontFamily:'inherit',cursor:'pointer'}}>{loading?'Adding...':'✓ Add Brand'}</button>
          <button onClick={onCancel} style={{flex:1,padding:9,borderRadius:6,background:'none',border:'1px solid var(--border)',color:'var(--muted)',fontSize:11,fontFamily:'inherit',cursor:'pointer'}}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

function DashboardStrip({runs}:{runs:Run[]}){
  const all=runs.flatMap(r=>r.orders),td=todayStr(),yd=yestStr(),pfx=td.slice(0,7)
  const tO=all.filter(o=>o.dateYMD===td),yO=all.filter(o=>o.dateYMD===yd),mO=all.filter(o=>o.dateYMD?.startsWith(pfx))
  const card=(label:string,val:string,sub:string)=>(
    <div style={{flex:1,background:'var(--surface)',border:'1px solid var(--border)',borderRadius:8,padding:'10px 12px',minWidth:0}}>
      <div style={{fontSize:8,color:'var(--muted)',textTransform:'uppercase',letterSpacing:'.08em',marginBottom:4}}>{label}</div>
      <div style={{fontSize:16,fontWeight:700,color:'var(--accent)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{val}</div>
      <div style={{fontSize:9,color:'var(--muted)',marginTop:2,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{sub}</div>
    </div>
  )
  return(
    <div style={{display:'flex',gap:6,marginBottom:14,overflow:'auto'}}>
      {card('Yesterday',yO.length?String(yO.length):'--',yO.length?`${fmtRs(yO.reduce((s,o)=>s+o.valueNum,0))} | COD ${yO.filter(o=>o.payment.toUpperCase()==='COD').length}`:'Not scraped yet')}
      {card('Today',tO.length?String(tO.length):'--',tO.length?`${fmtRs(tO.reduce((s,o)=>s+o.valueNum,0))} | COD ${tO.filter(o=>o.payment.toUpperCase()==='COD').length}`:'Not scraped')}
      {card('MTD',mO.length?String(mO.length):'--',mO.length?`${new Date().toLocaleString('en-IN',{month:'short',year:'numeric'})} · ${fmtRs(mO.reduce((s,o)=>s+o.valueNum,0)/mO.length)} avg`:'--')}
      {card('Total Tracked',String(all.length),`${runs.length} runs`)}
    </div>
  )
}

function DateTab({active,scanning,scanLabel,onStart,inp,lbl,forceRefresh,setForceRefresh}:any){
  const[from,setFrom]=useState(yestStr());const[to,setTo]=useState(todayStr());const[conc,setConc]=useState('5')
  const presetBtn=(label:string,f:string,t:string)=><button key={label} onClick={()=>{setFrom(f);setTo(t)}} style={{background:'var(--surface)',border:'1px solid var(--border)',color:'var(--muted)',padding:'6px 10px',borderRadius:20,fontSize:9,fontFamily:'inherit',cursor:'pointer'}}>{label}</button>
  return(
    <div>
      <div style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:6,padding:'8px 12px',marginBottom:12,fontSize:9,color:'var(--muted)',lineHeight:1.8}}>
        Anchor: <span style={{color:'var(--accent)'}}>#{active.idPrefix||''}{active.anchorId} = {active.anchorDate}</span> · slug: <span style={{color:'var(--accent)'}}>{active.slug}</span> · ~{active.avgPerDay}/day · {active.regressionPoints?.length||0} cal pts
      </div>
      {scanning&&scanLabel&&<div style={{background:'var(--surface)',border:'1px solid var(--accent)',borderRadius:6,padding:'7px 12px',marginBottom:10,fontSize:11,color:'var(--accent)',fontWeight:700}}>🔍 Scanning: {scanLabel}</div>}
      {!scanning&&(
        <>
          <div style={{display:'flex',gap:6,flexWrap:'wrap',marginBottom:10}}>
            {presetBtn('Today',todayStr(),todayStr())}
            {presetBtn('Yesterday',yestStr(),yestStr())}
            {presetBtn('Last 7 Days',daysAgoStr(6),todayStr())}
            {presetBtn('Last 30 Days',daysAgoStr(29),todayStr())}
            {presetBtn('MTD',monthStartStr(),todayStr())}
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:10}}>
            <div><label style={lbl}>From</label><input type="date" value={from} onChange={e=>setFrom(e.target.value)} style={inp}/></div>
            <div><label style={lbl}>To</label><input type="date" value={to} onChange={e=>setTo(e.target.value)} style={inp}/></div>
          </div>
          <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:12,fontSize:11,color:'var(--muted)'}}>
            <span>Concurrent fetches</span>
            <select value={conc} onChange={e=>setConc(e.target.value)} style={{...inp,width:'auto',padding:'5px 8px',fontSize:11}}>{['3','5','8','10','15'].map(v=><option key={v} value={v}>{v}</option>)}</select>
            <span style={{fontSize:9}}>(higher = faster)</span>
          </div>
          <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:8,padding:'6px 10px',background:'var(--surface)',borderRadius:6,border:'1px solid var(--border)'}}>
            <input type="checkbox" id="fr_date" checked={forceRefresh} onChange={(e:any)=>setForceRefresh(e.target.checked)} style={{accentColor:'var(--accent)',width:13,height:13,cursor:'pointer'}}/>
            <label htmlFor="fr_date" style={{fontSize:9,color:'var(--muted)',cursor:'pointer',lineHeight:1.4}}>Force Refresh — re-scan all IDs, ignore cache (slow)</label>
          </div>
          <button onClick={()=>onStart(from,to,parseInt(conc))} style={{width:'100%',background:'var(--accent)',color:'#000',border:'none',padding:11,borderRadius:8,fontSize:12,fontWeight:700,letterSpacing:'.06em',textTransform:'uppercase',marginBottom:12,fontFamily:'inherit',cursor:'pointer'}}>🔍 FIND &amp; SCRAPE</button>
        </>
      )}
    </div>
  )
}

function ManualTab({active,scanning,scanLabel,onStart,inp,lbl,forceRefresh,setForceRefresh}:any){
  const[startId,setStartId]=useState('');const[endId,setEndId]=useState('');const[useAuto,setUseAuto]=useState(false);const[stopAfter,setStopAfter]=useState('500');const[conc,setConc]=useState('5')
  const pfx=active.idPrefix||''
  const recommendedStop=recommendedAutoStop(parseInt(conc)||5,active?.avgPerDay||0)
  const storedResume=LS.get(`manual_resume_${active?.id}`,'')
  const resumeId=normalizeId(storedResume)
  useEffect(()=>{if(storedResume&&!resumeId&&active?.id)localStorage.removeItem(`manual_resume_${active.id}`)},[storedResume,resumeId,active?.id])
  return(
    <div>
      {scanning&&scanLabel&&<div style={{background:'var(--surface)',border:'1px solid var(--accent)',borderRadius:6,padding:'7px 12px',marginBottom:10,fontSize:11,color:'var(--accent)',fontWeight:700}}>🔍 Scanning: {scanLabel}</div>}
      {!scanning&&(
        <>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:10}}>
            <div><label style={lbl}>Start ID</label><input type="text" value={startId} onChange={e=>setStartId(e.target.value)} placeholder={`e.g. ${pfx}57700`} style={inp}/></div>
            <div><label style={lbl}>End ID</label><input type="text" value={endId} onChange={e=>setEndId(e.target.value)} placeholder={`e.g. ${pfx}73370`} disabled={useAuto} style={{...inp,opacity:useAuto?.4:1}}/></div>
          </div>
          <div style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:6,padding:'10px 12px',marginBottom:10,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
            <span style={{fontSize:10,color:'var(--muted)'}}>Auto-detect end (stop after N consecutive misses)</span>
            <input type="checkbox" checked={useAuto} onChange={e=>setUseAuto(e.target.checked)} style={{accentColor:'var(--accent)',width:16,height:16}}/>
          </div>
          {resumeId>0&&<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',background:'var(--surface2)',border:'1px solid var(--border)',borderRadius:6,padding:'8px 10px',marginBottom:10,fontSize:10,color:'var(--muted)'}}><span>Resume suggestion: start from #{pfx}{resumeId}</span><button onClick={()=>setStartId(String(resumeId))} style={{background:'none',border:'1px solid var(--accent)',color:'var(--accent)',padding:'4px 8px',borderRadius:4,fontSize:9,fontFamily:'inherit',cursor:'pointer'}}>Use resume ID</button></div>}
          {useAuto&&<div style={{marginBottom:10}}><label style={lbl}>Stop after N misses</label><div style={{display:'flex',alignItems:'center',gap:8}}><input type="number" value={stopAfter} onChange={e=>setStopAfter(e.target.value)} style={{...inp,width:90}}/><span style={{fontSize:9,color:'var(--muted)'}}>Safe floor here: {recommendedStop}. Lower values are auto-raised, and misses are retried once before counting.</span></div></div>}
          <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:12,fontSize:11,color:'var(--muted)'}}>
            <span>Concurrent fetches</span>
            <select value={conc} onChange={e=>setConc(e.target.value)} style={{...inp,width:'auto',padding:'5px 8px',fontSize:11}}>{['3','5','8','10'].map(v=><option key={v} value={v}>{v}</option>)}</select>
          </div>
          <button onClick={()=>{
            if(!startId){alert('Enter a Start ID');return}
            if(!useAuto&&!endId){alert('Enter End ID or enable auto-detect');return}
            const parsedStart=normalizeId(startId),parsedEnd=normalizeId(endId)
            if(!parsedStart){alert('Enter a valid numeric Start ID');return}
            if(!useAuto&&!parsedEnd){alert('Enter a valid numeric End ID');return}
            onStart(parsedStart,parsedEnd,parseInt(conc),useAuto,parseInt(stopAfter))
          }} style={{width:'100%',background:'var(--accent)',color:'#000',border:'none',padding:11,borderRadius:8,fontSize:12,fontWeight:700,letterSpacing:'.06em',textTransform:'uppercase',marginBottom:12,fontFamily:'inherit',cursor:'pointer'}}>▶ START MANUAL SCRAPE</button>
          <div style={{display:'flex',alignItems:'center',gap:8,marginTop:-6,marginBottom:8,padding:'6px 10px',background:'var(--surface)',borderRadius:6,border:'1px solid var(--border)'}}>
            <input type="checkbox" id="fr_manual" checked={forceRefresh} onChange={(e:any)=>setForceRefresh(e.target.checked)} style={{accentColor:'var(--accent)',width:13,height:13,cursor:'pointer'}}/>
            <label htmlFor="fr_manual" style={{fontSize:9,color:'var(--muted)',cursor:'pointer',lineHeight:1.4}}>Force Refresh — re-scan all IDs, ignore cache (slow)</label>
          </div>
        </>
      )}
    </div>
  )
}

function AnalyticsTab({analytics}:{analytics:Analytics|null}){
  if(!analytics)return<div style={{textAlign:'center',padding:'40px 20px',color:'var(--muted)',fontSize:11}}>Run a scan first to see analytics.</div>
  const a=analytics
  return(
    <div style={{display:'grid',gap:12}}>
      <div style={{display:'grid',gridTemplateColumns:'repeat(2,1fr)',gap:8}}>
        {[['Total Orders',String(a.totalOrders),`Daily avg ${a.avgDailyOrders}`],['Total Revenue',fmtRs(a.totalRevenue),`Daily avg ${fmtRs(a.avgDailyRevenue)}`],['Avg Order Value',fmtRs(a.avgOrderVal),`Trend: ${a.velocity}`],['COD vs Prepaid',`${a.codCount} / ${a.prepaidCount}`,`${a.codPct}% COD`],['Revenue Momentum',`${a.revenueMomentum}%`,'Recent vs early window'],['Tracked Statuses',String(a.statuses.length),'Distinct status labels']].map(([l,v,s])=>(
          <div key={l} style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:8,padding:'10px 12px'}}>
            <div style={{fontSize:8,color:'var(--muted)',textTransform:'uppercase',letterSpacing:'.08em',marginBottom:4}}>{l}</div>
            <div style={{fontSize:16,fontWeight:700,color:'var(--accent)'}}>{v}</div>
            {s&&<div style={{fontSize:9,color:'var(--muted)',marginTop:2}}>{s}</div>}
          </div>
        ))}
      </div>
      <Sec title="Top Cities (excl. courier hubs)">{a.topCities.slice(0,8).map(c=><Row key={c.city} label={c.city} value={String(c.count)}/>)}</Sec>
      <Sec title="Top Pincodes">{a.topPincodes.slice(0,8).map(p=><Row key={p.pincode} label={p.pincode} value={String(p.count)}/>)}</Sec>
      <Sec title="Status Breakdown">{a.statuses.slice(0,8).map(s=><Row key={s.status} label={s.status} value={String(s.count)}/>)}</Sec>
      <Sec title="Repeat Locations">{a.repeatLocations.length?a.repeatLocations.map(c=><Row key={c.city} label={c.city} value={String(c.count)}/>):<div style={{fontSize:10,color:'var(--muted)'}}>No repeat customer locations detected yet.</div>}</Sec>
      <Sec title="Peak Order Hours"><div style={{display:'flex',flexWrap:'wrap',gap:6}}>{a.hours.map(h=><div key={h.hour} style={{background:'var(--surface2)',border:'1px solid var(--border)',borderRadius:4,padding:'4px 10px',fontSize:10}}><b style={{color:'var(--accent)'}}>{h.hour}</b><span style={{color:'var(--muted)',marginLeft:6}}>{h.count}</span></div>)}</div></Sec>
      <Sec title="Value Distribution">{Object.entries(a.valueBuckets).map(([k,v])=><Row key={k} label={`Rs.${k}`} value={String(v)}/>)}</Sec>
      <Sec title="Daily Breakdown">
        <div style={{overflowX:'auto'}}><table style={{width:'100%',fontSize:10,borderCollapse:'collapse'}}>
          <thead><tr>{['Date','Orders','Revenue','COD','Prepaid'].map(h=><th key={h} style={{textAlign:h==='Date'?'left':'right',padding:'4px 8px',borderBottom:'1px solid var(--border)',color:'var(--muted)',fontWeight:600}}>{h}</th>)}</tr></thead>
          <tbody>{a.daily.map(d=><tr key={d.date} style={{borderBottom:'1px solid var(--border)'}}><td style={{padding:'4px 8px',color:'var(--text)'}}>{d.date}</td><td style={{padding:'4px 8px',color:'var(--accent)',textAlign:'right',fontWeight:700}}>{d.orders}</td><td style={{padding:'4px 8px',color:'var(--muted)',textAlign:'right'}}>{fmtRs(d.revenue)}</td><td style={{padding:'4px 8px',color:'var(--muted)',textAlign:'right'}}>{d.cod}</td><td style={{padding:'4px 8px',color:'var(--muted)',textAlign:'right'}}>{d.prepaid}</td></tr>)}</tbody>
        </table></div>
      </Sec>
    </div>
  )
}
function Sec({title,children}:{title:string,children:React.ReactNode}){return<div style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:8,padding:'10px 12px'}}><div style={{fontSize:8,color:'var(--muted)',textTransform:'uppercase',letterSpacing:'.08em',marginBottom:8}}>{title}</div>{children}</div>}
function Row({label,value}:{label:string,value:string}){return<div style={{display:'flex',justifyContent:'space-between',fontSize:11,padding:'3px 0',borderBottom:'1px solid var(--border)'}}><span style={{color:'var(--text)'}}>{label}</span><span style={{color:'var(--accent)',fontWeight:700}}>{value}</span></div>}

function CompareTab({brands}:{brands:Brand[]}){
  const snapshots=brands.map(b=>{
    const runs=LS.get<Run[]>(`runs_${b.id}`,[])
    const latest=runs[0],prev=runs[1]
    const latestA=latest?buildAnalytics(uniqueOrders(latest.orders)):null
    const prevA=prev?buildAnalytics(uniqueOrders(prev.orders)):null
    const delta=latestA&&prevA?latestA.totalOrders-prevA.totalOrders:null
    return latestA?{brand:b,latest,latestA,prevA,delta}:null
  }).filter(Boolean) as Array<{brand:Brand;latest:Run;latestA:Analytics;prevA:Analytics|null;delta:number|null}>
  if(!snapshots.length)return<div style={{textAlign:'center',padding:'40px 20px',color:'var(--muted)',fontSize:11}}>Run scans for multiple brands to compare them here.</div>
  const ranked=[...snapshots].sort((a,b)=>b.latestA.totalOrders-a.latestA.totalOrders)
  return(
    <div style={{display:'grid',gap:12}}>
      <Sec title="Latest Brand Snapshot">
        <div style={{overflowX:'auto'}}><table style={{width:'100%',fontSize:10,borderCollapse:'collapse'}}>
          <thead><tr>{['Brand','Range','Orders','Revenue','AOV','COD %','Velocity','Run Delta'].map(h=><th key={h} style={{textAlign:h==='Brand'||h==='Range'?'left':'right',padding:'4px 8px',borderBottom:'1px solid var(--border)',color:'var(--muted)',fontWeight:600}}>{h}</th>)}</tr></thead>
          <tbody>{ranked.map(({brand,latest,latestA,delta})=><tr key={brand.id} style={{borderBottom:'1px solid var(--border)'}}><td style={{padding:'6px 8px',color:'var(--accent)',fontWeight:700}}>{brand.name}</td><td style={{padding:'6px 8px',color:'var(--muted)'}}>{latest.dateRange}</td><td style={{padding:'6px 8px',textAlign:'right'}}>{latestA.totalOrders}</td><td style={{padding:'6px 8px',textAlign:'right'}}>{fmtRs(latestA.totalRevenue)}</td><td style={{padding:'6px 8px',textAlign:'right'}}>{fmtRs(latestA.avgOrderVal)}</td><td style={{padding:'6px 8px',textAlign:'right'}}>{latestA.codPct}%</td><td style={{padding:'6px 8px',textAlign:'right',color:'var(--accent)'}}>{latestA.velocity}</td><td style={{padding:'6px 8px',textAlign:'right',color:delta===null?'var(--muted)':delta>=0?'var(--accent)':'var(--warn)'}}>{delta===null?'--':`${delta>=0?'+':''}${delta}`}</td></tr>)}</tbody>
        </table></div>
      </Sec>
      <Sec title="Brand Movement Summary">
        <div style={{display:'grid',gap:8}}>
          {ranked.map(({brand,latestA,delta})=><div key={brand.id} style={{fontSize:10,color:'var(--muted)',lineHeight:1.8}}><b style={{color:'var(--accent)'}}>{brand.name}</b> is {latestA.velocity} with {latestA.totalOrders} orders, {fmtRs(latestA.totalRevenue)} revenue, {latestA.codPct}% COD and {delta===null?'no prior run for comparison':`${delta>=0?'an increase':'a drop'} of ${Math.abs(delta)} orders vs previous run`}.</div>)}
        </div>
      </Sec>
    </div>
  )
}

function HistoryTab({runs,brandName,onClear}:{runs:Run[],brandName:string,onClear:()=>void}){
  if(!runs.length)return<div style={{textAlign:'center',padding:'40px 20px',color:'var(--muted)',fontSize:11}}>No runs yet.</div>
  return(
    <div>
      {runs.map(r=>{const a=buildAnalytics(r.orders);return(
        <div key={r.runId} style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:8,padding:12,marginBottom:10}}>
          <div style={{display:'flex',justifyContent:'space-between',marginBottom:6}}><span style={{color:'var(--accent)',fontWeight:700,fontSize:12}}>{r.dateRange}</span><span style={{color:'var(--muted)',fontSize:9}}>{r.createdAt}</span></div>
          <div style={{display:'flex',gap:16,fontSize:10,marginBottom:8,flexWrap:'wrap'}}>
            <span style={{color:'var(--muted)'}}>Found: <b style={{color:'var(--text)'}}>{r.found}</b></span>
            {a&&<><span style={{color:'var(--muted)'}}>Rev: <b style={{color:'var(--text)'}}>{fmtRs(a.totalRevenue)}</b></span><span style={{color:'var(--muted)'}}>COD: <b style={{color:'var(--text)'}}>{a.codPct}%</b></span><span style={{color:'var(--muted)'}}>Avg: <b style={{color:'var(--text)'}}>{fmtRs(a.avgOrderVal)}</b></span></>}
          </div>
          {(a?.topCities?.length??0)>0&&<div style={{fontSize:9,color:'var(--muted)',marginBottom:8}}>{a!.topCities.slice(0,4).map(c=>`${c.city} (${c.count})`).join(' · ')} · {a!.velocity}</div>}
          <div style={{display:'flex',gap:6}}>
            <button onClick={()=>dlFile(buildCSV(r.orders),`${brandName}_${r.dateRange}.csv`)} style={{flex:1,background:'none',border:'1px solid var(--border)',color:'var(--text)',padding:7,borderRadius:6,fontSize:10,fontWeight:700,fontFamily:'inherit',cursor:'pointer'}}>↓ CSV</button>
            <button onClick={()=>dlFile(buildReport(r.orders,brandName,r.dateRange),`${brandName}_report.csv`)} style={{flex:1,background:'none',border:'1px solid var(--border)',color:'var(--text)',padding:7,borderRadius:6,fontSize:10,fontWeight:700,fontFamily:'inherit',cursor:'pointer'}}>↓ Report</button>
          </div>
        </div>
      )})}
      <button onClick={()=>{if(confirm('Clear all history?'))onClear()}} style={{width:'100%',background:'none',border:'1px solid var(--border)',color:'var(--muted)',padding:8,borderRadius:6,fontSize:10,marginTop:4,fontFamily:'inherit',cursor:'pointer'}}>Clear History</button>
    </div>
  )
}


// ── CSV Import ────────────────────────────────────────
const MONTHS_MAP:Record<string,string>={Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12'}
function parseCSVDate(d:string):string|null{
  const m=d.match(/^(\d{1,2})\s+(\w{3})\s+(\d{4})/)
  if(m)return`${m[3]}-${MONTHS_MAP[m[2]]||'00'}-${m[1].padStart(2,'0')}`
  const m2=d.match(/^(\d{4}-\d{2}-\d{2})/)
  return m2?m2[1]:null
}

function parseCSVLine(line:string):string[]{
  const out:string[]=[]
  let cur='',inQuotes=false
  for(let i=0;i<line.length;i++){
    const ch=line[i]
    if(ch==='"'){
      if(inQuotes&&line[i+1]==='"'){cur+='"';i++}
      else inQuotes=!inQuotes
    }else if(ch===','&&!inQuotes){
      out.push(cur.trim())
      cur=''
    }else cur+=ch
  }
  out.push(cur.trim())
  return out
}

function parseFullReportCSV(text:string):Order[]{
  const lines=text.split(/\r?\n/)
  let headerIdx=-1
  for(let i=0;i<lines.length;i++){
    const normalized=lines[i].replace(/"/g,'').trim()
    if(normalized.startsWith('Order ID,Date,Time')){headerIdx=i;break}
  }
  if(headerIdx<0)return[]
  const header=parseCSVLine(lines[headerIdx]).map(col=>col.replace(/^"|"$/g,'').trim().toLowerCase())
  const idx=(name:string)=>header.indexOf(name)
  const orderIdx=idx('order id'),dateIdx=idx('date'),timeIdx=idx('time'),valueIdx=idx('value'),paymentIdx=idx('payment'),statusIdx=idx('status'),locationIdx=idx('location'),pincodeIdx=idx('pincode')
  if(orderIdx<0||dateIdx<0||timeIdx<0||statusIdx<0||locationIdx<0||pincodeIdx<0)return[]
  const orders:Order[]=[]
  for(let i=headerIdx+1;i<lines.length;i++){
    const cols=parseCSVLine(lines[i]).map(col=>col.replace(/^"|"$/g,'').trim())
    if(cols.length<header.length)continue
    const orderId=cols[orderIdx]
    if(!orderId||isNaN(Number(orderId)))continue
    const orderDate=cols[dateIdx]||'N/A'
    const orderTime=cols[timeIdx]||'N/A'
    const value=valueIdx>=0?(cols[valueIdx]||'N/A'):'N/A'
    const payment=paymentIdx>=0?(cols[paymentIdx]||'N/A'):'N/A'
    const status=cols[statusIdx]||'N/A'
    const location=cols[locationIdx]||'N/A'
    const pincode=cols[pincodeIdx]||'N/A'
    const dateYMD=parseCSVDate(orderDate)
    orders.push({orderId:parseInt(orderId),slug:'',orderDate,orderTime,dateYMD,value,valueNum:parseFloat(value.replace(/[^0-9.]/g,''))||0,payment,status,pincode,location,source:'cache'})
  }
  return orders
}

function CachePanel({active,brands,forceRefresh,setForceRefresh,onImportOrders}:any){
  const[stats,setStats]=useState<{total:number,delivered:number,active:number,sizeKB:number}|null>(null)
  const[cleared,setCleared]=useState(false)
  const[importResult,setImportResult]=useState('')
  const[fileName,setFileName]=useState('')
  const fileInputRef=useRef<HTMLInputElement|null>(null)

  const refresh=()=>{
    if(!active)return
    const c=new OrderCache(active.id, active.slug||active.subdomain)
    const s=c.stats()
    setStats({...s,sizeKB:c.sizeKB()})
    setCleared(false)
  }

  useEffect(()=>{refresh()},[active?.id])

  function clearCache(){
    if(!active)return
    if(!confirm(`Clear all cached orders for ${active.name}? This will NOT delete run history. Next scan will re-fetch all orders.`))return
    new OrderCache(active.id, active.slug||active.subdomain).clear()
    setStats({total:0,delivered:0,active:0,sizeKB:0})
    setCleared(true)
  }

  const pct=stats?.total?Math.round(stats.delivered/stats.total*100):0

  async function handleImportFile(e:ChangeEvent<HTMLInputElement>){
    const file=e.target.files?.[0]
    if(!file||!active)return
    setFileName(file.name)
    const text=await file.text()
    const parsed=parseFullReportCSV(text)
    if(!parsed.length){
      setImportResult('⚠ No orders found — upload a Full Report or export CSV with an Order ID,Date,Time header')
      e.target.value=''
      return
    }
    const cache=new OrderCache(active.id, active.slug||active.subdomain)
    const {added,skipped}=cache.bulkLoad(parsed,active.slug||active.subdomain)
    cache.save()
    const final=parsed.filter(o=>isFinalStatus(o.status)).length
    const newStats=cache.stats()
    setStats({...newStats,sizeKB:cache.sizeKB()})
    setImportResult(`✓ Imported ${parsed.length} orders from ${file.name} (${final} delivered, ${added} written, ${skipped} unchanged)`)
    onImportOrders?.(parsed, file.name.replace(/\.csv$/i,''))
    e.target.value=''
  }

  return(
    <div style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:8,padding:14,marginBottom:14}}>
      <div style={{fontSize:10,fontWeight:700,color:'var(--accent)',marginBottom:8,textTransform:'uppercase',letterSpacing:'.06em'}}>⚡ Order Cache</div>
      {!stats||stats.total===0?(
        <div style={{fontSize:10,color:'var(--muted)'}}>No cache yet — run a scan to build the cache. Subsequent scans will skip cached Delivered orders automatically.</div>
      ):(
        <>
          <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:6,marginBottom:10}}>
            {[['Total',stats.total,'var(--text)'],['Delivered',stats.delivered,'var(--accent)'],['Active',stats.active,'var(--warn)'],['Size',stats.sizeKB+'KB','var(--muted)']].map(([l,v,c])=>(
              <div key={l} style={{background:'var(--surface2)',borderRadius:6,padding:'8px',textAlign:'center'}}>
                <div style={{fontSize:16,fontWeight:700,color:c as string}}>{v}</div>
                <div style={{fontSize:8,color:'var(--muted)',marginTop:2}}>{l}</div>
              </div>
            ))}
          </div>
          <div style={{background:'var(--bg)',borderRadius:4,height:6,overflow:'hidden',marginBottom:8}}>
            <div style={{height:'100%',background:'var(--accent)',width:pct+'%',borderRadius:4,transition:'width .3s'}}/>
          </div>
          <div style={{fontSize:9,color:'var(--muted)',marginBottom:10}}>{pct}% delivered (cached) · {100-pct}% active (will rescan)</div>
        </>
      )}
      <div style={{display:'flex',gap:6,alignItems:'center',flexWrap:'wrap'}}>
        <button onClick={refresh} style={{fontSize:9,padding:'5px 10px',background:'var(--surface2)',border:'1px solid var(--border)',borderRadius:4,color:'var(--text)',cursor:'pointer'}}>Refresh Stats</button>
        {stats&&stats.total>0&&<button onClick={clearCache} style={{fontSize:9,padding:'5px 10px',background:'var(--surface2)',border:'1px solid var(--red)',borderRadius:4,color:'var(--red)',cursor:'pointer'}}>Clear Cache</button>}
        <div style={{display:'flex',alignItems:'center',gap:6,marginLeft:'auto'}}>
          <input type="checkbox" id="fr_settings" checked={forceRefresh} onChange={(e:any)=>setForceRefresh(e.target.checked)} style={{accentColor:'var(--accent)',width:13,height:13,cursor:'pointer'}}/>
          <label htmlFor="fr_settings" style={{fontSize:9,color:'var(--muted)',cursor:'pointer'}}>Force Refresh (ignore cache)</label>
        </div>
      </div>
      {cleared&&<div style={{fontSize:9,color:'var(--accent)',marginTop:6}}>✓ Cache cleared</div>}
      {/* Import CSV */}
      <div style={{marginTop:10,paddingTop:10,borderTop:'1px solid var(--border)'}}>
        <div style={{fontSize:9,fontWeight:700,color:'var(--accent)',marginBottom:6,textTransform:'uppercase',letterSpacing:'.05em'}}>Import from CSV</div>
        <div style={{fontSize:9,color:'var(--muted)',marginBottom:6,lineHeight:1.6}}>Upload a Full Report CSV to seed the cache. Cached Delivered orders will be skipped on the next scan.</div>
        <input ref={fileInputRef} type="file" accept=".csv" style={{display:'none'}} onChange={handleImportFile}/>
        <button onClick={()=>fileInputRef.current?.click()} style={{display:'block',width:'100%',padding:'8px 12px',background:'var(--surface2)',border:'1px dashed var(--border)',borderRadius:6,cursor:'pointer',fontSize:9,color:'var(--muted)',textAlign:'center'}}>
          📂 {fileName?`Selected: ${fileName}`:'Click to upload Full Report CSV'}
        </button>
        {importResult&&<div style={{fontSize:9,marginTop:6,padding:'5px 8px',borderRadius:4,background:importResult.startsWith('✓')?'#00ff8815':'#ff444415',border:`1px solid ${importResult.startsWith('✓')?'var(--accent)':'var(--red)'}`,color:importResult.startsWith('✓')?'var(--accent)':'var(--red)'}}>{importResult}</div>}
      </div>
      <div style={{fontSize:8,color:'var(--muted)',marginTop:8,lineHeight:1.7}}>
        <b>How it works:</b> Complete order records are cached by Order ID. On the next scan, cached <b>Delivered</b> orders load instantly with full data and only non-final orders are re-fetched.<br/>
        Final state: <b>Delivered</b>
      </div>
    </div>
  )
}

function SettingsTab({brands,active,runs,onDelete,onSync,onImportOrders,inp,lbl,forceRefresh,setForceRefresh}:any){
  const[url,setUrl]=useState(()=>LS.get(`sheets_${active?.id}`,''));const[status,setStatus]=useState('');const[busy,setBusy]=useState(false)
  useEffect(()=>setUrl(LS.get(`sheets_${active?.id}`,'')),[ active?.id])
  const btn=(e:any={})=>({background:'var(--surface)',border:'1px solid var(--border)',color:'var(--text)',padding:'8px 12px',borderRadius:6,fontSize:10,fontWeight:700,fontFamily:'inherit',cursor:'pointer',...e})
  async function save(){LS.set(`sheets_${active.id}`,url);setStatus('✓ Saved — auto-syncs after every scan')}
  async function test(){if(!url){setStatus('⚠ Enter URL first');return};setBusy(true);setStatus('Testing...');try{const r=await fetch(url,{method:'POST',headers:{'Content-Type':'text/plain'},body:JSON.stringify({orders:[{orderId:'TEST',orderDate:'test',value:'Rs.1',payment:'COD',status:'test',location:'Mumbai',pincode:'400001'}],mode:'test'})});const d=await r.json();setStatus(d.ok?'✓ Connected!':'⚠ '+JSON.stringify(d))}catch(e:any){setStatus('⚠ '+e.message)};setBusy(false)}
  async function sync(mode:'append'|'replace'){if(!url){setStatus('⚠ Save URL first');return};const all=runs.flatMap((r:Run)=>r.orders);if(!all.length){setStatus('⚠ No orders to sync');return};setBusy(true);setStatus(`Syncing ${all.length} orders...`);const n=await onSync(url,all);setStatus(`✓ Synced ${n} rows`);setBusy(false)}
  const [tgStatus,setTgStatus]=useState('')
  const [tgBusy,setTgBusy]=useState(false)
  const [tgToken,setTgToken]=useState(()=>LS.get('tg_token',''))
  const [tgChat,setTgChat]=useState(()=>LS.get('tg_chat',''))
  const [tgBrandId,setTgBrandId]=useState(()=>LS.get('tg_brand',''))

  async function saveTg(){LS.set('tg_token',tgToken);LS.set('tg_chat',tgChat);LS.set('tg_brand',tgBrandId);setTgStatus('✓ Saved')}
  async function testTg(){
    if(!tgToken||!tgChat){setTgStatus('⚠ Enter token and chat ID first');return}
    setTgBusy(true);setTgStatus('Sending test...')
    try{
      await sendTelegramMsg(tgToken,tgChat,'✅ <b>Test from Shiprocket Order Scrapper</b>\nTelegram notifications are working!')
      setTgStatus('✓ Test message sent!')
    }catch(e:any){setTgStatus('⚠ '+e.message)}
    setTgBusy(false)
  }
  async function sendNow(){
    if(!tgToken||!tgChat){setTgStatus('⚠ Enter token and chat ID first');return}
    const brand=brands.find((b:Brand)=>b.id===tgBrandId)||brands[0]
    if(!brand){setTgStatus('⚠ Select a brand first');return}
    setTgBusy(true);setTgStatus('Sending report...')
    try{
      const allRuns=LS.get<Run[]>(`runs_${brand.id}`,[])
      const allOrders=allRuns.flatMap(r=>r.orders||[])
      if(!allOrders.length){setTgStatus('⚠ No scan data — run a scan first');setTgBusy(false);return}
      // Find most recent date in stored data
      const allDates=allOrders.map(o=>o.dateYMD).filter(Boolean).sort() as string[]
      const latestDate=allDates[allDates.length-1]||''
      const now=new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Kolkata'}))
      const today=now.toISOString().split('T')[0]
      const yest=new Date(now.getTime()-86400000).toISOString().split('T')[0]
      const dow=now.getDay()||7;const wStart=new Date(now.getTime()-(dow-1)*86400000).toISOString().split('T')[0]
      const mStart=today.slice(0,7)+'-01'
      const hasRecentData=allOrders.some(o=>o.dateYMD&&o.dateYMD>=wStart)
      const staleSuffix=!hasRecentData&&latestDate?'\n\n⚠️ Latest scan: '+latestDate+'\nRun a fresh scan for current numbers.':''
      const msg=buildTelegramReport(allOrders,brand.name,'',yest,wStart,mStart,today)+staleSuffix
      await sendTelegramMsg(tgToken,tgChat,msg)
      LS.set('tg_last_sent',today)
      // Send CSV of yesterday or most recent day with data
      const yestOrders=allOrders.filter((o:Order)=>o.dateYMD===yest)
      const csvOrders=yestOrders.length>0?yestOrders:allOrders.filter((o:Order)=>o.dateYMD===latestDate)
      if(csvOrders.length>0){
        const csvDate=yestOrders.length>0?yest:latestDate
        const csv='Order ID,Date,Time,Value,Payment,Status,Location,Pincode,Source\n'+
          csvOrders.map((o:Order)=>`${o.orderId},${o.orderDate},${o.orderTime},${o.value},${o.payment},${o.status},${o.location},${o.pincode},${o.source||"fresh"}`).join('\n')
        await sendTelegramDoc(tgToken,tgChat,`${brand.name}_${csvDate}.csv`,csv,`Orders for ${csvDate} — ${brand.name}`)
      }
      setTgStatus('✓ Report sent!')
    }catch(e:any){setTgStatus('⚠ '+e.message)}
    setTgBusy(false)
  }

  return(
    <div>
      {/* Cache Management */}
      <CachePanel active={active} brands={brands} forceRefresh={forceRefresh} setForceRefresh={setForceRefresh} onImportOrders={onImportOrders}/>

      {/* Telegram */}
      <div style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:8,padding:14,marginBottom:14}}>
        <div style={{fontSize:10,fontWeight:700,color:'var(--accent)',marginBottom:4,textTransform:'uppercase',letterSpacing:'.06em'}}>📱 Telegram Daily Report</div>
        <div style={{fontSize:9,color:'var(--muted)',marginBottom:10,lineHeight:1.9}}>
          1. Message <a href="https://t.me/BotFather" target="_blank" style={{color:'var(--accent)'}}>@BotFather</a> → /newbot → copy the token<br/>
          2. Message your bot once, then get your chat ID from <a href="https://api.telegram.org/bot{TOKEN}/getUpdates" target="_blank" style={{color:'var(--accent)'}}>getUpdates</a><br/>
          3. Opens the app 7–10 AM IST → auto-sends morning report<br/>
          4. For fully automatic (no browser needed): set env vars in Vercel dashboard
        </div>
        <div style={{display:'grid',gap:8,marginBottom:8}}>
          <div><label style={lbl}>Bot Token</label><input value={tgToken} onChange={(e:any)=>setTgToken(e.target.value)} placeholder="1234567890:AAxxxxxxx" style={inp} type="password"/></div>
          <div><label style={lbl}>Chat ID (your Telegram user ID or group ID)</label><input value={tgChat} onChange={(e:any)=>setTgChat(e.target.value)} placeholder="-100123456789 or 123456789" style={inp}/></div>
          <div><label style={lbl}>Brand to report on</label>
            <select value={tgBrandId} onChange={(e:any)=>setTgBrandId(e.target.value)} style={{...inp,padding:'8px 10px'}}>
              <option value="">All brands</option>
              {brands.map((b:Brand)=><option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
        </div>
        {tgStatus&&<div style={{fontSize:10,padding:'6px 10px',borderRadius:4,marginBottom:8,
          background:tgStatus.startsWith('✓')?'#00ff8815':'#ff444415',
          border:`1px solid ${tgStatus.startsWith('✓')?'var(--accent)':'var(--red)'}`,
          color:tgStatus.startsWith('✓')?'var(--accent)':'var(--red)'}}>{tgStatus}</div>}
        <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
          <button onClick={saveTg} style={btn()}>Save</button>
          <button onClick={testTg} disabled={tgBusy} style={btn()}>Test</button>
          <button onClick={sendNow} disabled={tgBusy} style={btn({color:'var(--accent)',borderColor:'var(--accent)'})}>Send Report Now</button>
          <button onClick={async()=>{
            const brand2=brands.find((b:Brand)=>b.id===tgBrandId)||brands[0]
            if(!brand2){setTgStatus('⚠ Select a brand');return}
            setTgBusy(true);setTgStatus('Syncing runs to server...')
            const runs2=LS.get<Run[]>(`runs_${brand2.id}`,[])
            const res=await fetch('/api/run-store',{method:'POST',headers:{'Content-Type':'application/json'},
              body:JSON.stringify({subdomain:brand2.subdomain,runs:runs2.slice(0,20)})})
            const d=await res.json()
            setTgStatus(d.ok?`✓ Synced ${d.count} runs to server`:'⚠ Sync failed')
            setTgBusy(false)
          }} disabled={tgBusy} style={btn({color:'var(--muted)'})} title="Needed for Vercel Cron to access your data">Sync to Server</button>
        </div>
        <div style={{fontSize:8,color:'var(--muted)',marginTop:8,lineHeight:1.8}}>
          <b>For fully automatic (no browser needed):</b> Add env vars to Vercel dashboard:<br/>
          TELEGRAM_BOT_TOKEN · TELEGRAM_CHAT_ID · BRAND_SUBDOMAIN · BRAND_NAME
        </div>
      </div>
      <div style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:8,padding:14,marginBottom:14}}>
        <div style={{fontSize:10,fontWeight:700,color:'var(--accent)',marginBottom:10,textTransform:'uppercase',letterSpacing:'.06em'}}>Google Sheets Sync</div>
        <div style={{fontSize:9,color:'var(--muted)',marginBottom:10,lineHeight:1.8}}>1. Go to <a href="https://script.google.com" target="_blank" style={{color:'var(--accent)'}}>script.google.com</a> → New project<br/>2. Paste the code below → Deploy as web app (execute as: Me, who has access: Anyone)<br/>3. Copy the /exec URL and paste here</div>
        <details style={{marginBottom:10}}><summary style={{fontSize:9,color:'var(--muted)',cursor:'pointer',marginBottom:6}}>▼ Apps Script code</summary>
          <pre style={{background:'var(--surface2)',border:'1px solid var(--border)',borderRadius:4,padding:8,fontSize:8,color:'var(--muted)',overflow:'auto',maxHeight:180,lineHeight:1.6,whiteSpace:'pre-wrap'}}>{`function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('Orders') || ss.insertSheet('Orders');
    if (data.mode === 'replace' || sheet.getLastRow() === 0) {
      sheet.clearContents();
      sheet.appendRow(['Order ID','Date','Time','Value','Payment','Status','Location','Pincode']);
    }
    data.orders.forEach(function(o) {
      sheet.appendRow([o.orderId,o.orderDate,o.orderTime,o.value,o.payment,o.status,o.location,o.pincode]);
    });
    return ContentService.createTextOutput(JSON.stringify({ok:true,added:data.orders.length})).setMimeType(ContentService.MimeType.JSON);
  } catch(e) {
    return ContentService.createTextOutput(JSON.stringify({ok:false,error:e.message})).setMimeType(ContentService.MimeType.JSON);
  }
}`}</pre>
        </details>
        <div style={{marginBottom:8}}><label style={lbl}>Webhook URL</label><input value={url} onChange={(e:any)=>setUrl(e.target.value)} placeholder="https://script.google.com/macros/s/.../exec" style={inp}/></div>
        {status&&<div style={{fontSize:10,padding:'6px 10px',borderRadius:4,marginBottom:8,background:status.startsWith('✓')?'#00ff8815':'#ff444415',border:`1px solid ${status.startsWith('✓')?'var(--accent)':'var(--red)'}`,color:status.startsWith('✓')?'var(--accent)':'var(--red)'}}>{status}</div>}
        <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
          <button onClick={save} style={btn()}>Save URL</button>
          <button onClick={test} disabled={busy} style={btn()}>Test</button>
          <button onClick={()=>sync('append')} disabled={busy} style={btn({color:'var(--accent)',borderColor:'var(--accent)'})}>↑ Sync Append</button>
          <button onClick={()=>sync('replace')} disabled={busy} style={btn({color:'var(--warn)',borderColor:'var(--warn)'})}>↺ Sync Replace</button>
        </div>
      </div>
      <div style={{fontSize:9,color:'var(--muted)',textTransform:'uppercase',letterSpacing:'.08em',marginBottom:8}}>Manage Brands</div>
      {brands.map((b:Brand)=>(
        <div key={b.id} style={{background:'var(--surface)',border:`1px solid ${b.id===active.id?'var(--accent)':'var(--border)'}`,borderRadius:8,padding:12,marginBottom:8}}>
          <div style={{fontWeight:700,color:'var(--accent)',fontSize:12,marginBottom:2}}>{b.name}</div>
          <div style={{fontSize:9,color:'var(--muted)',marginBottom:8,lineHeight:1.8}}>{b.subdomain}.shiprocket.co · slug: {b.slug} · ~{b.avgPerDay}/day<br/>anchor: #{b.idPrefix||''}{b.anchorId} ({b.anchorDate}) · {b.regressionPoints?.length||0} cal pts{b.idPrefix?` · prefix: ${b.idPrefix}`:''}</div>
          <button onClick={()=>onDelete(b.id)} style={{background:'none',border:'1px solid var(--red)',color:'var(--red)',padding:'5px 12px',borderRadius:4,fontSize:9,fontWeight:700,fontFamily:'inherit',cursor:'pointer'}}>Delete Brand</button>
        </div>
      ))}
      <div style={{marginTop:12,padding:12,background:'var(--surface)',border:'1px solid var(--border)',borderRadius:8,fontSize:9,color:'var(--muted)',lineHeight:2}}>
        <b style={{color:'var(--accent)'}}>How it works</b><br/>Scan logic runs in your browser — no server timeouts.<br/>Server only proxies Shiprocket API calls (CORS bypass).<br/>Data in browser localStorage · Free forever · by RahulJ
      </div>
    </div>
  )
}
