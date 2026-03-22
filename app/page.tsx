'use client'
import { useState, useEffect, useRef, useCallback } from 'react'

// ── Types ─────────────────────────────────────────────
interface Brand { id:string; name:string; subdomain:string; slug:string; companyName:string; anchorId:number; anchorDate:string; avgPerDay:number; regressionPoints:Array<{date:string,id:number}> }
interface Order { orderId:number; slug:string; orderDate:string; orderTime:string; dateYMD:string|null; value:string; valueNum:number; payment:string; status:string; pincode:string; location:string }
interface Run { runId:string; dateRange:string; found:number; scanned:number; orders:Order[]; createdAt:string }
interface Analytics { totalOrders:number; totalRevenue:number; avgOrderVal:number; codCount:number; prepaidCount:number; codPct:number; topCities:Array<{city:string,count:number}>; daily:Array<{date:string,orders:number,revenue:number,cod:number,prepaid:number}>; hours:Array<{hour:string,count:number}>; valueBuckets:Record<string,number>; velocity:string }
interface LogLine { msg:string; cls:string }

// ── Utils ─────────────────────────────────────────────
const LS = { get:<T,>(k:string,d:T):T=>{try{const v=localStorage.getItem(k);return v?JSON.parse(v):d}catch{return d}}, set:(k:string,v:any)=>{try{localStorage.setItem(k,JSON.stringify(v))}catch{}} }
const fmtRs = (n:number) => 'Rs.'+Math.round(n||0).toLocaleString('en-IN')
const todayStr = () => { const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` }
const yestStr  = () => { const d=new Date(); d.setDate(d.getDate()-1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` }
const sortOrders = (o:Order[]) => [...o].sort((a,b)=>(a.dateYMD||'').localeCompare(b.dateYMD||'')||(a.orderTime||'').localeCompare(b.orderTime||''))
const RTO = new Set(['HUB','ETAIL','E-TAIL','SORTING','GATEWAY','DEPOT','FACILITY','WAREHOUSE','PROCESSING','COUNTER','DISPATCH'])
const isRTO = (c:string) => { const u=(c||'').toUpperCase().trim(); if(!u||u==='N/A')return true; return u.split(/[\s,\-]+/).some((w:string)=>RTO.has(w)) }

// ── Analytics ─────────────────────────────────────────
function buildAnalytics(orders:Order[]):Analytics|null {
  if(!orders.length) return null
  const N=orders.length, rev=orders.reduce((s,r)=>s+(r.valueNum||0),0)
  const cod=orders.filter(r=>(r.payment||'').toUpperCase()==='COD')
  const cityMap:Record<string,number>={}, dayMap:Record<string,any>={}, hourMap:Record<string,number>={}
  const valMap:Record<string,number>={'0-500':0,'500-1k':0,'1k-1.5k':0,'1.5k-2k':0,'2k+':0}
  orders.forEach(r=>{
    const c=(r.location||'N/A').trim(); if(!isRTO(c)) cityMap[c]=(cityMap[c]||0)+1
    if(r.dateYMD){ if(!dayMap[r.dateYMD])dayMap[r.dateYMD]={orders:0,revenue:0,cod:0,prepaid:0}; dayMap[r.dateYMD].orders++; dayMap[r.dateYMD].revenue+=r.valueNum||0; (r.payment||'').toUpperCase()==='COD'?dayMap[r.dateYMD].cod++:dayMap[r.dateYMD].prepaid++ }
    if(r.orderTime&&r.orderTime!=='N/A'){const h=r.orderTime.slice(0,2)+'h';hourMap[h]=(hourMap[h]||0)+1}
    const v=r.valueNum||0; if(v<500)valMap['0-500']++;else if(v<1000)valMap['500-1k']++;else if(v<1500)valMap['1k-1.5k']++;else if(v<2000)valMap['1.5k-2k']++;else valMap['2k+']++
  })
  const topCities=Object.entries(cityMap).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([city,count])=>({city,count}))
  const daily=Object.keys(dayMap).sort().map(k=>({date:k,...dayMap[k]}))
  const hours=Object.entries(hourMap).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([h,c])=>({hour:h,count:c}))
  let velocity='stable'; if(daily.length>=6){const rec=daily.slice(-3).reduce((s,d)=>s+d.orders,0)/3,old=daily.slice(0,3).reduce((s,d)=>s+d.orders,0)/3;if(rec>old*1.15)velocity='growing';else if(rec<old*0.85)velocity='shrinking'}
  return{totalOrders:N,totalRevenue:rev,avgOrderVal:rev/N,codCount:cod.length,prepaidCount:N-cod.length,codPct:Math.round((cod.length/N)*100),topCities,daily,hours,valueBuckets:valMap,velocity}
}

// ── CSV / Report ──────────────────────────────────────
const esc = (v:any) => `"${String(v??'').replace(/"/g,'""')}"`
const fmt = (n:number) => 'Rs.'+Number(n||0).toFixed(2)
function buildCSV(orders:Order[]):string {
  let s='Order ID,Date,Time,Value,Payment,Status,Location,Pincode\n'
  sortOrders(orders).forEach(r=>s+=`${esc(r.orderId)},${esc(r.orderDate)},${esc(r.orderTime)},${esc(r.value)},${esc(r.payment)},${esc(r.status)},${esc(r.location)},${esc(r.pincode)}\n`)
  return s
}
function buildReport(orders:Order[],brandName:string,dateRange:string):string {
  const a=buildAnalytics(orders); if(!a)return''
  const fd=(ymd:string)=>{const[y,m,d]=ymd.split('-');return new Date(+y,+m-1,+d).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'})}
  let s=`BRAND INTELLIGENCE REPORT\nBrand,${esc(brandName)}\nDate Range,${esc(dateRange)}\nGenerated,${new Date().toLocaleString('en-IN')}\n\n`
  s+=`SUMMARY\nTotal Orders,${a.totalOrders}\nRevenue,${fmt(a.totalRevenue)}\nAvg Value,${fmt(a.avgOrderVal)}\nCOD,${a.codCount} (${a.codPct}%)\nPrepaid,${a.prepaidCount}\nVelocity,${a.velocity}\n\n`
  s+='TOP CITIES\nCity,Orders\n'; a.topCities.forEach(c=>s+=`${esc(c.city)},${c.count}\n`)
  s+='\nPEAK HOURS\nHour,Orders\n'; a.hours.forEach(h=>s+=`${esc(h.hour)},${h.count}\n`)
  s+='\nVALUE DISTRIBUTION\nBucket,Orders\n'; Object.entries(a.valueBuckets).forEach(([k,v])=>s+=`${esc('Rs.'+k)},${v}\n`)
  s+='\nDAILY BREAKDOWN\nDate,Orders,Revenue,COD,Prepaid\n'; a.daily.forEach(d=>s+=`${esc(fd(d.date))},${d.orders},${fmt(d.revenue)},${d.cod},${d.prepaid}\n`)
  s+='\nFULL ORDER LIST\nOrder ID,Date,Time,Value,Payment,Status,Location,Pincode\n'; sortOrders(orders).forEach(r=>s+=`${esc(r.orderId)},${esc(r.orderDate)},${esc(r.orderTime)},${esc(r.value)},${esc(r.payment)},${esc(r.status)},${esc(r.location)},${esc(r.pincode)}\n`)
  return s
}
function dlFile(content:string,filename:string){const a=document.createElement('a');a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(content);a.download=filename;a.click()}

// ── CSS vars helper ───────────────────────────────────
const darkVars = {'--bg':'#0d0d0d','--surface':'#161616','--surface2':'#1e1e1e','--border':'#252525','--accent':'#00ff88','--warn':'#ff6b35','--text':'#e8e8e8','--muted':'#555','--red':'#ff4444'}
const lightVars = {'--bg':'#f5f5f0','--surface':'#fff','--surface2':'#efefea','--border':'#ddd','--accent':'#008844','--warn':'#cc5500','--text':'#111','--muted':'#888','--red':'#cc2222'}

// ═══════════════════════════════════════════════════════
//  MAIN APP
// ═══════════════════════════════════════════════════════
export default function App() {
  const [light,setLight] = useState(false)
  const [brands,setBrands] = useState<Brand[]>([])
  const [active,setActive] = useState<Brand|null>(null)
  const [tab,setTab] = useState<'date'|'manual'|'analytics'|'history'|'settings'>('date')
  const [runs,setRuns] = useState<Run[]>([])
  const [lastOrders,setLastOrders] = useState<Order[]>([])
  const [analytics,setAnalytics] = useState<Analytics|null>(null)
  const [scanning,setScanning] = useState(false)
  const [log,setLog] = useState<LogLine[]>([{msg:'Select a date range and click Find & Scrape.',cls:''}])
  const [progress,setProgress] = useState({done:0,total:0,found:0})
  const [startedAt,setStartedAt] = useState(0)
  const [showAdd,setShowAdd] = useState(false)
  const abortRef = useRef<AbortController|null>(null)
  const ordersRef = useRef<Order[]>([])
  const logRef = useRef<HTMLDivElement>(null)
  const vars = light ? lightVars : darkVars

  useEffect(()=>{
    const l=LS.get('lightMode',false); setLight(l)
    const bs=LS.get<Brand[]>('brands',[]); setBrands(bs)
    const aid=LS.get('activeBrandId',''); const b=bs.find((x:Brand)=>x.id===aid)||bs[0]||null
    if(b){setActive(b);loadRuns(b)}
  },[])

  useEffect(()=>{if(logRef.current)logRef.current.scrollTop=logRef.current.scrollHeight},[log])

  // Warn on tab hide during scan
  useEffect(()=>{
    const fn=()=>{ if(document.hidden&&scanning) addLog('⚠ Tab hidden — scan may slow. Keep this tab active!','err') }
    document.addEventListener('visibilitychange',fn)
    return()=>document.removeEventListener('visibilitychange',fn)
  },[scanning])

  function loadRuns(b:Brand){
    const r=LS.get<Run[]>(`runs_${b.id}`,[]);setRuns(r)
    if(r.length>0){setLastOrders(r[0].orders);setAnalytics(buildAnalytics(r[0].orders))}
    else{setLastOrders([]);setAnalytics(null)}
  }

  function selectBrand(b:Brand){setActive(b);LS.set('activeBrandId',b.id);loadRuns(b)}
  function deleteBrand(id:string){
    if(!confirm('Delete this brand and all data?'))return
    const u=brands.filter(b=>b.id!==id);setBrands(u);LS.set('brands',u);localStorage.removeItem(`runs_${id}`)
    const n=u[0]||null;setActive(n);if(n)loadRuns(n);else{setRuns([]);setLastOrders([]);setAnalytics(null)}
  }

  const addLog = useCallback((msg:string,cls:string='')=>setLog(p=>[...p.slice(-400),{msg,cls}]),[])

  function saveRun(orders:Order[],label:string,scanned:number){
    if(!active)return
    const run:Run={runId:Date.now().toString(),dateRange:label,found:orders.length,scanned,orders,createdAt:new Date().toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'})}
    const updated=[run,...LS.get<Run[]>(`runs_${active.id}`,[])].slice(0,50)
    LS.set(`runs_${active.id}`,updated);setRuns(updated);setLastOrders(orders);setAnalytics(buildAnalytics(orders))
    // Update regression points
    const byDate:Record<string,{min:number,max:number}>={}
    orders.forEach(o=>{if(!o.dateYMD)return;if(!byDate[o.dateYMD])byDate[o.dateYMD]={min:o.orderId,max:o.orderId};else{byDate[o.dateYMD].min=Math.min(byDate[o.dateYMD].min,o.orderId);byDate[o.dateYMD].max=Math.max(byDate[o.dateYMD].max,o.orderId)}})
    const newPts=Object.entries(byDate).map(([date,{min,max}])=>({date,id:Math.round((min+max)/2)}))
    const merged=Object.values(Object.fromEntries([...(active.regressionPoints||[]),...newPts].map(p=>[p.date,p]))).sort((a:any,b:any)=>a.date.localeCompare(b.date)) as Array<{date:string,id:number}>
    const regPts=merged.slice(-30)
    let newAvg=active.avgPerDay
    if(merged.length>=2){const f=merged[0],l=merged[merged.length-1];const days=(new Date(l.date+' 00:00:00').getTime()-new Date(f.date+' 00:00:00').getTime())/86400000;if(days>0)newAvg=Math.min(500,Math.max(1,Math.ceil((l.id-f.id)/days)))}
    const u2={...active,regressionPoints:regPts,avgPerDay:newAvg}
    setActive(u2);const ab2=brands.map(b=>b.id===active.id?u2:b);setBrands(ab2);LS.set('brands',ab2)
    // Auto-sync sheets
    const url=LS.get(`sheets_${active.id}`,'')
    if(url&&orders.length>0) autoSyncSheets(url,orders).then(n=>addLog(`✓ Sheets: ${n} rows synced`,'ok'))
  }

  async function autoSyncSheets(url:string,orders:Order[]):Promise<number>{
    let added=0
    const BATCH=200
    for(let i=0;i<orders.length;i+=BATCH){
      try{const res=await fetch(url,{method:'POST',headers:{'Content-Type':'text/plain'},body:JSON.stringify({orders:orders.slice(i,i+BATCH),mode:i===0?'append':'append'})});const d=await res.json();if(d.ok)added+=d.added||0}catch{}
      await new Promise(r=>setTimeout(r,500))
    }
    return added
  }

  const [scanLabel,setScanLabel]=useState('')

  async function startScan(params:any){
    if(!active||scanning)return
    setScanning(true);setLog([]);setProgress({done:0,total:0,found:0});setStartedAt(Date.now());ordersRef.current=[]
    if('wakeLock' in navigator){try{(navigator as any).wakeLock.request('screen').catch(()=>{})}catch{}}
    addLog('⚠ Keep this tab active — switching tabs may pause the scan','info')
    const ab=new AbortController();abortRef.current=ab
    const allOrders:Order[]=[]
    const totalRef={val:0}
    const label0=params.fromDate?`${params.fromDate} → ${params.toDate}`:params.startId?`#${params.startId} → #${params.endId||'auto'}`:'scan'
    setScanLabel(label0)

    const base={...params,
      subdomain:active.subdomain,slug:active.slug,
      anchorId:active.anchorId,anchorDate:active.anchorDate,
      avgPerDay:active.avgPerDay,regressionPoints:active.regressionPoints}

    // processStream: reads one SSE response, adds orders, returns chunk_done payload or null
    const processStream = async (res:Response):Promise<any|null> => {
      const reader=res.body!.getReader()
      const dec=new TextDecoder()
      let buf='', chunkPayload:any=null

      try {
        while(true){
          const{done,value}=await reader.read()
          if(done) break
          buf+=dec.decode(value,{stream:true})
          const lines=buf.split('\n'); buf=lines.pop()||''
          for(const line of lines){
            if(!line.startsWith('data: ')) continue
            try{
              const d=JSON.parse(line.slice(6))
              if(d.type==='log')        addLog(d.msg,d.cls||'')
              else if(d.type==='order') { allOrders.push(d.order); ordersRef.current=[...allOrders] }
              else if(d.type==='range') { totalRef.val=d.total; setProgress(p=>({...p,total:d.total})) }
              else if(d.type==='start') { if(d.total&&!totalRef.val){ totalRef.val=d.total; setProgress(p=>({...p,total:d.total})) } }
              else if(d.type==='progress') setProgress({done:d.done,total:totalRef.val||d.total,found:allOrders.length})
              else if(d.type==='error') addLog('⚠ '+d.msg,'err')
              else if(d.type==='chunk_done'){
                // Merge any orders sent with chunk (server may include them)
                if(d.chunkOrders){
                  const existing=new Set(allOrders.map((o:Order)=>o.orderId))
                  d.chunkOrders.forEach((o:Order)=>{ if(!existing.has(o.orderId)){ allOrders.push(o); ordersRef.current=[...allOrders] } })
                }
                chunkPayload=d
              }
              else if(d.type==='done') { chunkPayload=null; return null } // null = fully done
            }catch{}
          }
        }
      } finally { reader.releaseLock() }

      return chunkPayload // non-null = more chunks needed
    }

    try{
      let currentParams:any = base
      let chunkNum = 0

      while(!ab.signal.aborted){
        chunkNum++
        addLog(chunkNum===1 ? `Starting scan...` : `Chunk ${chunkNum}: #${currentParams.scanStart}...`, 'info')

        const res = await fetch('/api/scan', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify(currentParams),
          signal:ab.signal
        })
        if(!res.ok||!res.body) throw new Error(`HTTP ${res.status}`)

        const chunk = await processStream(res)

        if(chunk===null) break // done

        if(!chunk?.nextStart){
          addLog('Scan complete (no more chunks)','info')
          break
        }

        // Build next chunk params
        currentParams = {
          ...base,
          mode:        chunk.mode || base.mode || 'date',
          scanStart:   chunk.nextStart,
          scanEnd:     chunk.scanEnd,
          originalStart: chunk.originalStart || base.originalStart || chunk.nextStart,
          fromDate:    chunk.fromDate || base.fromDate,
          toDate:      chunk.toDate   || base.toDate,
          startId:     chunk.startId  || base.startId,
          endId:       chunk.endId    || base.endId,
          useAuto:     chunk.useAuto  !== undefined ? chunk.useAuto  : base.useAuto,
          stopAfter:   chunk.stopAfter|| base.stopAfter,
          runId:       chunk.runId
        }
        addLog(`→ ${allOrders.length} orders found so far, continuing...`,'info')
      }

      const dates=allOrders.map(r=>r.dateYMD).filter(Boolean).sort()
      const label=dates.length===0
        ? (params.fromDate?`${params.fromDate} to ${params.toDate}`:'scan')
        : dates[0]===dates[dates.length-1] ? dates[0]!
        : `${dates[0]} to ${dates[dates.length-1]}`
      saveRun(allOrders,label,totalRef.val)
      addLog(`✓ Done: ${label} — ${allOrders.length} orders`,'ok')

    }catch(e:any){
      if(e.name!=='AbortError') addLog('Error: '+e.message,'err')
      if(ordersRef.current.length>0){
        const o=ordersRef.current
        const dates=o.map(r=>r.dateYMD).filter(Boolean).sort()
        const lbl=dates.length===0?'partial':`${dates[0]} to ${dates[dates.length-1]} (partial)`
        saveRun(o,lbl,0)
        addLog(`Saved ${o.length} orders collected so far`,'info')
      }
    }finally{setScanning(false);setScanLabel('')}
  }

  function stopScan(){abortRef.current?.abort()}

  const eta=(()=>{
    if(!startedAt||!progress.done||!progress.total)return''
    const elapsed=(Date.now()-startedAt)/1000,rate=progress.done/elapsed,rem=rate>0?(progress.total-progress.done)/rate:0
    if(rem>=3600)return`${Math.floor(rem/3600)}h ${Math.floor((rem%3600)/60)}m`
    if(rem>=60)return`${Math.floor(rem/60)}m ${Math.floor(rem%60)}s`
    return`${Math.floor(rem)}s`
  })()

  const S = (extra:any={}) => ({fontFamily:'inherit',cursor:'pointer',...extra})
  const inp = {width:'100%',padding:'8px 10px',fontSize:12,background:'var(--surface)',border:'1px solid var(--border)',color:'var(--text)',borderRadius:6,fontFamily:'inherit',outline:'none'} as const
  const lbl = {fontSize:9,color:'var(--muted)',letterSpacing:'.08em',textTransform:'uppercase' as const,display:'block' as const,marginBottom:4}

  return(
    <div style={{...(vars as any),background:'var(--bg)',color:'var(--text)',minHeight:'100vh',fontFamily:"'JetBrains Mono','Fira Code','Courier New',monospace",transition:'background .2s,color .2s'}}>
    <div style={{maxWidth:940,margin:'0 auto',padding:'20px 16px'}}>

      {/* Header */}
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:18}}>
        <div>
          <div style={{fontSize:13,fontWeight:700,letterSpacing:'.1em',color:'var(--accent)',textTransform:'uppercase'}}>Shiprocket Order Scrapper</div>
          <div style={{fontSize:9,color:'var(--muted)',marginTop:2}}>by RahulJ · PRO v5.0 · Free Web Edition</div>
        </div>
        <div style={{display:'flex',gap:8,alignItems:'center'}}>
          <button onClick={()=>{const n=!light;setLight(n);LS.set('lightMode',n)}} style={S({background:'var(--surface)',border:'1px solid var(--border)',color:'var(--text)',width:32,height:32,borderRadius:6,fontSize:15})}>{light?'🌙':'☀️'}</button>
          <button onClick={()=>setShowAdd(true)} style={S({background:'var(--accent)',color:'#000',border:'none',padding:'8px 16px',borderRadius:6,fontSize:11,fontWeight:700,letterSpacing:'.06em'})}>+ ADD BRAND</button>
        </div>
      </div>

      {/* Add Brand */}
      {showAdd && <AddBrand onAdd={b=>{const u=[...brands,b];setBrands(u);LS.set('brands',u);selectBrand(b);setShowAdd(false)}} onCancel={()=>setShowAdd(false)}/>}

      {/* Brand selector */}
      {brands.length>0&&!showAdd&&(
        <div style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:8,padding:'8px 12px',marginBottom:12,display:'flex',alignItems:'center',gap:10}}>
          <span style={{fontSize:9,color:'var(--muted)',textTransform:'uppercase',letterSpacing:'.08em',flexShrink:0}}>Brand</span>
          <select value={active?.id||''} onChange={e=>{const b=brands.find(x=>x.id===e.target.value);if(b)selectBrand(b)}} style={{flex:1,border:'none',background:'transparent',color:'var(--text)',fontSize:13,fontWeight:700,outline:'none',fontFamily:'inherit'}}>
            {brands.map(b=><option key={b.id} value={b.id} style={{background:'var(--surface)'}}>{b.name} ({b.subdomain}.shiprocket.co)</option>)}
          </select>
          <span style={{fontSize:9,color:'var(--muted)',flexShrink:0}}>~{active?.avgPerDay}/day · {active?.regressionPoints?.length||0} cal pts</span>
        </div>
      )}

      {/* No brand */}
      {!brands.length&&!showAdd&&(
        <div style={{textAlign:'center',padding:'60px 20px',color:'var(--muted)'}}>
          <div style={{fontSize:32,marginBottom:16}}>📦</div>
          <div style={{fontSize:13,marginBottom:8}}>No brands added yet</div>
          <div style={{fontSize:11,lineHeight:2}}>Click <span style={{color:'var(--accent)'}}>+ ADD BRAND</span> to start</div>
        </div>
      )}

      {/* Main */}
      {active&&!showAdd&&(
        <>
          {/* Dashboard */}
          <Dashboard runs={runs}/>

          {/* Tabs */}
          <div style={{display:'flex',borderBottom:'1px solid var(--border)',marginBottom:16,overflowX:'auto'}}>
            {(['date','manual','analytics','history','settings'] as const).map(t=>(
              <button key={t} onClick={()=>setTab(t)} style={S({background:'none',border:'none',borderBottom:`2px solid ${tab===t?'var(--accent)':'transparent'}`,color:tab===t?'var(--accent)':'var(--muted)',fontSize:10,fontWeight:700,letterSpacing:'.08em',textTransform:'uppercase',padding:'8px 14px',marginBottom:-1,whiteSpace:'nowrap'})}>
                {t==='date'?'By Date':t.charAt(0).toUpperCase()+t.slice(1)}
              </button>
            ))}
          </div>

          {tab==='date'&&(
            <DateTab active={active} scanning={scanning} log={log} progress={progress} eta={eta} logRef={logRef} lastOrders={lastOrders}
              onStart={(from,to,conc)=>startScan({mode:'date',fromDate:from,toDate:to,concurrency:conc})}
              onStop={stopScan}/>
          )}
          {tab==='manual'&&(
            <ManualTab active={active} scanning={scanning} log={log} progress={progress} eta={eta} logRef={logRef} lastOrders={lastOrders}
              onStart={(sid,eid,auto,sa,conc)=>startScan({mode:'manual',startId:sid,endId:eid,useAuto:auto,stopAfter:sa,concurrency:conc})}
              onStop={stopScan}/>
          )}
          {tab==='analytics'&&<AnalyticsTab analytics={analytics}/>}
          {tab==='history'&&<HistoryTab runs={runs} brand={active} onClear={()=>{localStorage.removeItem(`runs_${active.id}`);setRuns([]);setLastOrders([]);setAnalytics(null)}}/>}
          {tab==='settings'&&<SettingsTab brands={brands} active={active} runs={runs} onDelete={deleteBrand} onAutoSync={autoSyncSheets}/>}
        </>
      )}
    </div>
    </div>
  )
}

// ── Add Brand ─────────────────────────────────────────
function AddBrand({onAdd,onCancel}:{onAdd:(b:Brand)=>void,onCancel:()=>void}){
  const [url,setUrl]=useState('');const [name,setName]=useState('');const [sub,setSub]=useState('')
  const [oid,setOid]=useState('');const [date,setDate]=useState('');const [msg,setMsg]=useState<{text:string,ok:boolean}|null>(null);const [busy,setBusy]=useState(false)
  const inp={width:'100%',padding:'8px 10px',fontSize:12,background:'var(--surface)',border:'1px solid var(--border)',color:'var(--text)',borderRadius:6,fontFamily:'inherit',outline:'none'}
  const lbl={fontSize:9,color:'var(--muted)',letterSpacing:'.08em',textTransform:'uppercase' as const,display:'block' as const,marginBottom:4}
  function handleUrl(v:string){setUrl(v);const m=v.match(/https?:\/\/([^.]+)\.shiprocket\.co/);if(m){setSub(m[1]);if(!name)setName(m[1][0].toUpperCase()+m[1].slice(1))}}
  async function add(){
    if(!name||!sub||!oid||!date){setMsg({text:'Fill all fields',ok:false});return}
    setBusy(true);setMsg({text:'Detecting...',ok:true})
    const dr=await fetch('/api/detect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subdomain:sub,orderId:oid})})
    const dd=await dr.json()
    if(!dd.ok){setMsg({text:dd.error||'Cannot fetch order. Check subdomain + order ID.',ok:false});setBusy(false);return}
    const er=await fetch('/api/estimate-avg',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subdomain:sub,anchorId:parseInt(oid),slug:dd.slug})})
    const ed=await er.json()
    onAdd({id:Date.now().toString(),name,subdomain:sub,slug:dd.slug,companyName:dd.companyName,anchorId:parseInt(oid),anchorDate:date,avgPerDay:ed.avgPerDay||30,regressionPoints:[]})
    setBusy(false)
  }
  return(
    <div style={{background:'var(--surface)',border:'1px solid var(--accent)',borderRadius:10,padding:20,marginBottom:16}}>
      <div style={{fontSize:11,fontWeight:700,color:'var(--accent)',letterSpacing:'.08em',textTransform:'uppercase',marginBottom:14}}>+ Add New Brand</div>
      <div style={{display:'grid',gap:10}}>
        <div><label style={lbl}>Shiprocket URL (auto-fills subdomain)</label><input value={url} onChange={e=>handleUrl(e.target.value)} placeholder="https://everlasting.shiprocket.co/" style={inp}/></div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
          <div><label style={lbl}>Brand Name</label><input value={name} onChange={e=>setName(e.target.value)} placeholder="e.g. Everlasting" style={inp}/></div>
          <div><label style={lbl}>Subdomain</label><input value={sub} onChange={e=>setSub(e.target.value)} placeholder="e.g. everlasting" style={inp}/></div>
        </div>
        <div style={{background:'var(--surface2)',border:'1px solid var(--border)',borderRadius:6,padding:'8px 10px',fontSize:9,color:'var(--warn)'}}>⚠ Use order ID (e.g. 61083) — NOT tracking ID (like 76806566966 from courier)</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
          <div><label style={lbl}>One Known Order ID</label><input type="number" value={oid} onChange={e=>setOid(e.target.value)} placeholder="e.g. 61083" style={inp}/></div>
          <div><label style={lbl}>That Order's Date</label><input type="date" value={date} onChange={e=>setDate(e.target.value)} style={inp}/></div>
        </div>
        {msg&&<div style={{padding:'8px 10px',borderRadius:6,fontSize:11,background:msg.ok?'#00ff8815':'#ff444415',border:`1px solid ${msg.ok?'var(--accent)':'var(--red)'}`,color:msg.ok?'var(--accent)':'var(--red)'}}>{msg.text}</div>}
        <div style={{display:'flex',gap:8}}>
          <button onClick={add} disabled={busy} style={{flex:2,padding:10,borderRadius:6,background:'var(--accent)',border:'none',color:'#000',fontSize:11,fontWeight:700,fontFamily:'inherit',cursor:'pointer'}}>{busy?'Adding...':'✓ Add Brand'}</button>
          <button onClick={onCancel} style={{flex:1,padding:10,borderRadius:6,background:'none',border:'1px solid var(--border)',color:'var(--muted)',fontSize:11,fontFamily:'inherit',cursor:'pointer'}}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

// ── Dashboard ─────────────────────────────────────────
function Dashboard({runs}:{runs:Run[]}){
  const all=runs.flatMap(r=>r.orders)
  const td=todayStr(),yd=yestStr(),pfx=td.slice(0,7)
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

// ── Scan Log + Progress (shared) ──────────────────────
function ScanPanel({scanning,log,progress,eta,logRef,lastOrders,brand,onStop,csvName,reportLabel}:any){
  const pct=progress.total?Math.min(progress.done/progress.total*100,100):0
  const S=(e:any={})=>({fontFamily:'inherit',cursor:'pointer',...e})
  return(
    <>
      {scanning&&(
        <>
          <div style={{marginBottom:10}}>
            <div style={{display:'flex',justifyContent:'space-between',fontSize:10,color:'var(--muted)',marginBottom:5}}>
              <span>{progress.done}/{progress.total||'?'} — <b style={{color:'var(--accent)'}}>{progress.found} found</b></span>
              <span style={{color:'var(--accent)'}}>{eta?`ETA: ${eta}`:'Calculating...'}</span>
            </div>
            <div style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:4,height:6,overflow:'hidden'}}>
              <div style={{height:'100%',background:'var(--accent)',width:`${pct}%`,transition:'width .4s',borderRadius:4}}/>
            </div>
          </div>
          <button onClick={onStop} style={S({width:'100%',background:'var(--surface)',color:'var(--red)',border:'1px solid var(--red)',padding:10,borderRadius:8,fontSize:11,fontWeight:700,marginBottom:12})}>■ STOP (saves results found so far)</button>
        </>
      )}
      <div ref={logRef} style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:6,padding:10,minHeight:80,maxHeight:240,overflowY:'auto',fontSize:10,lineHeight:1.8,marginBottom:12}}>
        {log.map((l:LogLine,i:number)=>(
          <div key={i} style={{color:l.cls==='ok'?'var(--accent)':l.cls==='err'?'var(--red)':l.cls==='info'?'var(--warn)':'var(--muted)'}}>{l.msg}</div>
        ))}
      </div>
      {lastOrders.length>0&&!scanning&&(
        <div style={{display:'flex',gap:8}}>
          <button onClick={()=>dlFile(buildCSV(lastOrders),csvName)} style={S({flex:1,background:'var(--surface)',border:'1px solid var(--border)',color:'var(--text)',padding:9,borderRadius:6,fontSize:11,fontWeight:700})}>↓ CSV ({lastOrders.length})</button>
          <button onClick={()=>dlFile(buildReport(lastOrders,brand.name,reportLabel),`${brand.name}_report.csv`)} style={S({flex:1,background:'var(--surface)',border:'1px solid var(--border)',color:'var(--text)',padding:9,borderRadius:6,fontSize:11,fontWeight:700})}>↓ Full Report</button>
          <button onClick={()=>{const a=buildAnalytics(lastOrders);if(!a)return;const top=a.topCities[0];const txt=`📦 *${brand.name}*\nOrders: *${a.totalOrders}* | Revenue: *${fmtRs(a.totalRevenue)}*\nCOD: ${a.codCount} (${a.codPct}%) | Avg: ${fmtRs(a.avgOrderVal)}\n`+(top?`🏆 ${top.city} (${top.count})\n`:'')+`📈 ${a.velocity}`;navigator.clipboard.writeText(txt).then(()=>alert('Copied!'))}} style={S({flex:1,background:'var(--surface)',border:'1px solid #25d366',color:'#25d366',padding:9,borderRadius:6,fontSize:11,fontWeight:700})}>📱 WA</button>
        </div>
      )}
    </>
  )
}

// ── Date Tab ──────────────────────────────────────────
function DateTab({active,scanning,scanLabel,log,progress,eta,logRef,lastOrders,onStart,onStop}:any){
  const [from,setFrom]=useState(yestStr());const [to,setTo]=useState(todayStr());const [conc,setConc]=useState('5')
  const inp={width:'100%',padding:'8px 10px',fontSize:13,background:'var(--surface)',border:'1px solid var(--border)',color:'var(--text)',borderRadius:6,fontFamily:'inherit',outline:'none'}
  const lbl={fontSize:9,color:'var(--muted)',letterSpacing:'.08em',textTransform:'uppercase' as const,display:'block' as const,marginBottom:4}
  const S=(e:any={})=>({fontFamily:'inherit',cursor:'pointer',...e})
  return(
    <div>
      <div style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:6,padding:'8px 12px',marginBottom:12,fontSize:9,color:'var(--muted)',lineHeight:1.8}}>
        Anchor: <span style={{color:'var(--accent)'}}>#{active.anchorId} = {active.anchorDate}</span> · slug: <span style={{color:'var(--accent)'}}>{active.slug}</span> · ~{active.avgPerDay}/day · {active.regressionPoints?.length||0} cal pts
      </div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:10}}>
        <div><label style={lbl}>From</label><input type="date" value={from} onChange={e=>setFrom(e.target.value)} style={inp}/></div>
        <div><label style={lbl}>To</label><input type="date" value={to} onChange={e=>setTo(e.target.value)} style={inp}/></div>
      </div>
      <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:12,fontSize:11,color:'var(--muted)'}}>
        <span>Concurrent fetches</span>
        <select value={conc} onChange={e=>setConc(e.target.value)} style={{...inp,width:'auto',padding:'5px 8px',fontSize:11}}>
          {['3','5','8','10','15'].map(v=><option key={v} value={v}>{v}</option>)}
        </select>
        <span style={{fontSize:9}}>(higher = faster)</span>
      </div>
      {!scanning&&<button onClick={()=>onStart(from,to,parseInt(conc))} style={S({width:'100%',background:'var(--accent)',color:'#000',border:'none',padding:11,borderRadius:8,fontSize:12,fontWeight:700,letterSpacing:'.06em',textTransform:'uppercase',marginBottom:12})}>🔍 FIND &amp; SCRAPE</button>}
      <ScanPanel scanning={scanning} log={log} progress={progress} eta={eta} logRef={logRef} lastOrders={lastOrders} brand={active} onStop={onStop} csvName={`${active.name}_${from}_to_${to}.csv`} reportLabel={`${from} to ${to}`}/>
    </div>
  )
}

// ── Manual Tab ────────────────────────────────────────
function ManualTab({active,scanning,log,progress,eta,logRef,lastOrders,onStart,onStop}:any){
  const [sid,setSid]=useState('');const [eid,setEid]=useState('');const [auto,setAuto]=useState(false);const [sa,setSa]=useState('500');const [conc,setConc]=useState('5')
  const inp={width:'100%',padding:'8px 10px',fontSize:12,background:'var(--surface)',border:'1px solid var(--border)',color:'var(--text)',borderRadius:6,fontFamily:'inherit',outline:'none'}
  const lbl={fontSize:9,color:'var(--muted)',letterSpacing:'.08em',textTransform:'uppercase' as const,display:'block' as const,marginBottom:4}
  const S=(e:any={})=>({fontFamily:'inherit',cursor:'pointer',...e})
  return(
    <div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:10}}>
        <div><label style={lbl}>Start ID</label><input type="number" value={sid} onChange={e=>setSid(e.target.value)} placeholder="e.g. 57700" style={inp}/></div>
        <div><label style={lbl}>End ID</label><input type="number" value={eid} onChange={e=>setEid(e.target.value)} disabled={auto} placeholder="e.g. 73500" style={{...inp,opacity:auto?.4:1}}/></div>
      </div>
      <div style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:6,padding:'10px 12px',marginBottom:8,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
        <label style={{fontSize:10,color:'var(--muted)',cursor:'pointer'}} onClick={()=>setAuto(!auto)}>Auto-detect end (stop after N consecutive misses)</label>
        <input type="checkbox" checked={auto} onChange={e=>setAuto(e.target.checked)} style={{accentColor:'var(--accent)',width:16,height:16,cursor:'pointer'}}/>
      </div>
      {auto&&(
        <div style={{marginBottom:10}}>
          <label style={lbl}>Stop after N misses (use 500+ at 10x to avoid false stops from rate limits)</label>
          <input type="number" value={sa} onChange={e=>setSa(e.target.value)} style={{...inp,width:120}}/>
        </div>
      )}
      <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:12,fontSize:11,color:'var(--muted)'}}>
        <span>Concurrent fetches</span>
        <select value={conc} onChange={e=>setConc(e.target.value)} style={{...inp,width:'auto',padding:'5px 8px',fontSize:11}}>
          {['3','5','8','10'].map(v=><option key={v} value={v}>{v}</option>)}
        </select>
      </div>
      {!scanning&&<button onClick={()=>{if(!sid){alert('Enter start ID');return};if(!auto&&!eid){alert('Enter end ID or enable auto');return};onStart(parseInt(sid),eid?parseInt(eid):undefined,auto,parseInt(sa),parseInt(conc))}} style={S({width:'100%',background:'var(--accent)',color:'#000',border:'none',padding:11,borderRadius:8,fontSize:12,fontWeight:700,letterSpacing:'.06em',textTransform:'uppercase',marginBottom:12})}>▶ START MANUAL SCRAPE</button>}
      <ScanPanel scanning={scanning} log={log} progress={progress} eta={eta} logRef={logRef} lastOrders={lastOrders} brand={active} onStop={onStop} csvName={`${active.name}_manual_${sid}.csv`} reportLabel={`manual #${sid}–${eid}`}/>
    </div>
  )
}

// ── Analytics Tab ─────────────────────────────────────
function AnalyticsTab({analytics}:{analytics:Analytics|null}){
  if(!analytics)return<div style={{textAlign:'center',padding:'40px 20px',color:'var(--muted)',fontSize:11}}>Run a scan first.</div>
  const a=analytics
  const Sec=({title,children}:{title:string,children:any})=><div style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:8,padding:'10px 12px',marginBottom:10}}><div style={{fontSize:8,color:'var(--muted)',textTransform:'uppercase',letterSpacing:'.08em',marginBottom:8}}>{title}</div>{children}</div>
  const Row=({l,v}:{l:string,v:string})=><div style={{display:'flex',justifyContent:'space-between',fontSize:11,padding:'3px 0',borderBottom:'1px solid var(--border)'}}><span style={{color:'var(--text)'}}>{l}</span><span style={{color:'var(--accent)',fontWeight:700}}>{v}</span></div>
  return(
    <div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(2,1fr)',gap:8,marginBottom:10}}>
        {[['Total Orders',String(a.totalOrders),''],['Total Revenue',fmtRs(a.totalRevenue),''],['Avg Value',fmtRs(a.avgOrderVal),`Trend: ${a.velocity}`],['COD / Prepaid',`${a.codCount} / ${a.prepaidCount}`,`${a.codPct}% COD`]].map(([l,v,s])=>(
          <div key={l} style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:8,padding:'10px 12px'}}>
            <div style={{fontSize:8,color:'var(--muted)',textTransform:'uppercase',letterSpacing:'.08em',marginBottom:4}}>{l}</div>
            <div style={{fontSize:16,fontWeight:700,color:'var(--accent)'}}>{v}</div>
            {s&&<div style={{fontSize:9,color:'var(--muted)',marginTop:2}}>{s}</div>}
          </div>
        ))}
      </div>
      <Sec title="Top Cities (excl. courier hubs)">{a.topCities.slice(0,8).map(c=><Row key={c.city} l={c.city} v={String(c.count)}/>)}</Sec>
      <Sec title="Peak Order Hours"><div style={{display:'flex',flexWrap:'wrap',gap:6}}>{a.hours.map(h=><div key={h.hour} style={{background:'var(--surface2)',border:'1px solid var(--border)',borderRadius:4,padding:'4px 10px',fontSize:10}}><b style={{color:'var(--accent)'}}>{h.hour}</b><span style={{color:'var(--muted)',marginLeft:6}}>{h.count}</span></div>)}</div></Sec>
      <Sec title="Value Distribution">{Object.entries(a.valueBuckets).map(([k,v])=><Row key={k} l={`Rs.${k}`} v={String(v)}/>)}</Sec>
      <Sec title="Daily Breakdown">
        <div style={{overflowX:'auto'}}>
          <table style={{width:'100%',fontSize:10,borderCollapse:'collapse'}}>
            <thead><tr>{['Date','Orders','Revenue','COD','Prepaid'].map(h=><th key={h} style={{textAlign:h==='Date'?'left':'right',padding:'4px 8px',borderBottom:'1px solid var(--border)',color:'var(--muted)',fontWeight:600}}>{h}</th>)}</tr></thead>
            <tbody>{a.daily.map(d=><tr key={d.date} style={{borderBottom:'1px solid var(--border)'}}><td style={{padding:'4px 8px',color:'var(--text)'}}>{d.date}</td><td style={{padding:'4px 8px',color:'var(--accent)',textAlign:'right',fontWeight:700}}>{d.orders}</td><td style={{padding:'4px 8px',color:'var(--muted)',textAlign:'right'}}>{fmtRs(d.revenue)}</td><td style={{padding:'4px 8px',color:'var(--muted)',textAlign:'right'}}>{d.cod}</td><td style={{padding:'4px 8px',color:'var(--muted)',textAlign:'right'}}>{d.prepaid}</td></tr>)}</tbody>
          </table>
        </div>
      </Sec>
    </div>
  )
}

// ── History Tab ───────────────────────────────────────
function HistoryTab({runs,brand,onClear}:{runs:Run[],brand:Brand,onClear:()=>void}){
  if(!runs.length)return<div style={{textAlign:'center',padding:'40px 20px',color:'var(--muted)',fontSize:11}}>No runs yet.</div>
  const S=(e:any={})=>({fontFamily:'inherit',cursor:'pointer',...e})
  return(
    <div>
      {runs.map(r=>{
        const a=buildAnalytics(r.orders)
        return(
          <div key={r.runId} style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:8,padding:12,marginBottom:10}}>
            <div style={{display:'flex',justifyContent:'space-between',marginBottom:6}}>
              <span style={{color:'var(--accent)',fontWeight:700,fontSize:12}}>{r.dateRange}</span>
              <span style={{color:'var(--muted)',fontSize:9}}>{r.createdAt}</span>
            </div>
            <div style={{display:'flex',gap:14,fontSize:10,marginBottom:8,flexWrap:'wrap'}}>
              <span style={{color:'var(--muted)'}}>Found: <b style={{color:'var(--text)'}}>{r.found}</b></span>
              {a&&<><span style={{color:'var(--muted)'}}>Rev: <b style={{color:'var(--text)'}}>{fmtRs(a.totalRevenue)}</b></span><span style={{color:'var(--muted)'}}>COD: <b style={{color:'var(--text)'}}>{a.codPct}%</b></span><span style={{color:'var(--muted)'}}>Avg: <b style={{color:'var(--text)'}}>{fmtRs(a.avgOrderVal)}</b></span></>}
            </div>
            {a?.topCities.length>0&&<div style={{fontSize:9,color:'var(--muted)',marginBottom:8}}>{a.topCities.slice(0,4).map(c=>`${c.city} (${c.count})`).join(' · ')} · {a.velocity}</div>}
            <div style={{display:'flex',gap:6}}>
              <button onClick={()=>dlFile(buildCSV(r.orders),`${brand.name}_${r.dateRange}.csv`)} style={S({flex:1,background:'none',border:'1px solid var(--border)',color:'var(--text)',padding:7,borderRadius:6,fontSize:10,fontWeight:700})}>↓ CSV</button>
              <button onClick={()=>dlFile(buildReport(r.orders,brand.name,r.dateRange),`${brand.name}_report.csv`)} style={S({flex:1,background:'none',border:'1px solid var(--border)',color:'var(--text)',padding:7,borderRadius:6,fontSize:10,fontWeight:700})}>↓ Report</button>
            </div>
          </div>
        )
      })}
      <button onClick={()=>{if(confirm('Clear all history?'))onClear()}} style={{width:'100%',background:'none',border:'1px solid var(--border)',color:'var(--muted)',padding:8,borderRadius:6,fontSize:10,marginTop:4,fontFamily:'inherit',cursor:'pointer'}}>Clear History</button>
    </div>
  )
}

// ── Settings Tab ──────────────────────────────────────
function SettingsTab({brands,active,runs,onDelete,onAutoSync}:any){
  const [url,setUrl]=useState(()=>LS.get(`sheets_${active?.id}`,''))
  const [status,setStatus]=useState('')
  const [busy,setBusy]=useState(false)
  useEffect(()=>setUrl(LS.get(`sheets_${active?.id}`,'')),[ active?.id])
  const S=(e:any={})=>({fontFamily:'inherit',cursor:'pointer',background:'var(--surface)',border:'1px solid var(--border)',color:'var(--text)',padding:'8px 12px',borderRadius:6,fontSize:10,fontWeight:700,...e})
  const inp={width:'100%',padding:'8px 10px',fontSize:11,background:'var(--surface)',border:'1px solid var(--border)',color:'var(--text)',borderRadius:6,fontFamily:'inherit',outline:'none'}
  async function save(){LS.set(`sheets_${active.id}`,url);setStatus('✓ Saved — will auto-sync after every scan')}
  async function test(){
    if(!url){setStatus('⚠ Enter URL first');return}
    setBusy(true);setStatus('Testing...')
    try{const r=await fetch(url,{method:'POST',headers:{'Content-Type':'text/plain'},body:JSON.stringify({orders:[{orderId:'TEST',orderDate:'test',value:'Rs.1',payment:'COD',status:'test',location:'Mumbai',pincode:'400001'}],mode:'test'})});const d=await r.json();setStatus(d.ok?'✓ Connected!':'⚠ '+JSON.stringify(d))}catch(e:any){setStatus('⚠ '+e.message)}
    setBusy(false)
  }
  async function sync(mode:'append'|'replace'){
    if(!url){setStatus('⚠ Save URL first');return}
    const all=runs.flatMap((r:Run)=>r.orders)
    if(!all.length){setStatus('⚠ No orders to sync');return}
    setBusy(true);setStatus(`Syncing ${all.length} orders...`)
    const n=await onAutoSync(url,all);setStatus(`✓ Synced ${n} rows`);setBusy(false)
  }
  return(
    <div>
      {/* Sheets */}
      <div style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:8,padding:14,marginBottom:14}}>
        <div style={{fontSize:10,fontWeight:700,color:'var(--accent)',marginBottom:10,textTransform:'uppercase',letterSpacing:'.06em'}}>Google Sheets Sync</div>
        <div style={{fontSize:9,color:'var(--muted)',marginBottom:10,lineHeight:1.8}}>
          1. Go to <a href="https://script.google.com" target="_blank" style={{color:'var(--accent)'}}>script.google.com</a> → New project<br/>
          2. Paste the script below → Deploy as web app (Anyone can access)<br/>
          3. Copy the /exec URL and paste here
        </div>
        <details style={{marginBottom:10}}>
          <summary style={{fontSize:9,color:'var(--muted)',cursor:'pointer',marginBottom:6}}>▼ Show Apps Script code</summary>
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
        <div style={{marginBottom:8}}>
          <div style={{fontSize:9,color:'var(--muted)',letterSpacing:'.08em',textTransform:'uppercase',marginBottom:4}}>Webhook URL</div>
          <input value={url} onChange={e=>setUrl(e.target.value)} placeholder="https://script.google.com/macros/s/.../exec" style={inp}/>
        </div>
        {status&&<div style={{fontSize:10,padding:'6px 10px',borderRadius:4,marginBottom:8,background:status.startsWith('✓')?'#00ff8815':'#ff444415',border:`1px solid ${status.startsWith('✓')?'var(--accent)':'var(--red)'}`,color:status.startsWith('✓')?'var(--accent)':'var(--red)'}}>{status}</div>}
        <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
          <button onClick={save} style={S()}>Save URL</button>
          <button onClick={test} disabled={busy} style={S()}>Test</button>
          <button onClick={()=>sync('append')} disabled={busy} style={S({color:'var(--accent)',borderColor:'var(--accent)'})}>↑ Sync (Append)</button>
          <button onClick={()=>sync('replace')} disabled={busy} style={S({color:'var(--warn)',borderColor:'var(--warn)'})}>↺ Sync (Replace)</button>
        </div>
      </div>

      {/* Brands */}
      <div style={{fontSize:9,color:'var(--muted)',textTransform:'uppercase',letterSpacing:'.08em',marginBottom:8}}>Manage Brands</div>
      {brands.map((b:Brand)=>(
        <div key={b.id} style={{background:'var(--surface)',border:`1px solid ${b.id===active.id?'var(--accent)':'var(--border)'}`,borderRadius:8,padding:12,marginBottom:8}}>
          <div style={{fontWeight:700,color:'var(--accent)',fontSize:12,marginBottom:2}}>{b.name}</div>
          <div style={{fontSize:9,color:'var(--muted)',marginBottom:8,lineHeight:1.8}}>{b.subdomain}.shiprocket.co · slug: {b.slug} · ~{b.avgPerDay}/day · anchor: #{b.anchorId} ({b.anchorDate}) · {b.regressionPoints?.length||0} cal pts</div>
          <button onClick={()=>onDelete(b.id)} style={{background:'none',border:'1px solid var(--red)',color:'var(--red)',padding:'5px 12px',borderRadius:4,fontSize:9,fontWeight:700,fontFamily:'inherit',cursor:'pointer'}}>Delete</button>
        </div>
      ))}
      <div style={{marginTop:12,padding:12,background:'var(--surface)',border:'1px solid var(--border)',borderRadius:8,fontSize:9,color:'var(--muted)',lineHeight:2}}>
        <b style={{color:'var(--accent)'}}>About</b><br/>Data in browser localStorage · Scraping via Vercel Edge (server-side IPs) · Free forever · by RahulJ
      </div>
    </div>
  )
}
