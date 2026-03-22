'use client'

import { useState, useEffect, useRef, useCallback } from 'react'

// ── Types ─────────────────────────────────────────────
interface Brand {
  id: string; name: string; subdomain: string; slug: string
  companyName: string; anchorId: number; anchorDate: string
  avgPerDay: number; regressionPoints: Array<{date:string,id:number}>
}
interface Order {
  orderId: number; slug: string; orderDate: string; orderTime: string
  dateYMD: string|null; value: string; valueNum: number
  payment: string; status: string; pincode: string; location: string
}
interface ScanRun {
  runId: string; dateRange: string; found: number; scanned: number
  orders: Order[]; createdAt: string
}
interface Analytics {
  totalOrders:number; totalRevenue:number; avgOrderVal:number
  codCount:number; prepaidCount:number; codPct:number
  topCities:Array<{city:string,count:number}>
  daily:Array<{date:string,orders:number,revenue:number,cod:number,prepaid:number}>
  hours:Array<{hour:string,count:number}>; valueBuckets:Record<string,number>; velocity:string
}

// ── Storage ───────────────────────────────────────────
const LS = {
  get:<T,>(k:string,d:T):T=>{try{const v=localStorage.getItem(k);return v?JSON.parse(v):d}catch{return d}},
  set:(k:string,v:any)=>{try{localStorage.setItem(k,JSON.stringify(v))}catch{}}
}

// ── Analytics ─────────────────────────────────────────
const RTO_WORDS = new Set(['HUB','ETAIL','E-TAIL','SORTING','GATEWAY','DEPOT','FACILITY','WAREHOUSE','PROCESSING','COUNTER','DISPATCH'])
const isRTO=(c:string)=>{const u=(c||'').toUpperCase().trim();if(!u||u==='N/A')return true;return u.split(/[\s,\-]+/).some(w=>RTO_WORDS.has(w))}

function buildAnalytics(orders:Order[]):Analytics|null {
  if(!orders.length)return null
  const N=orders.length, rev=orders.reduce((s,r)=>s+(r.valueNum||0),0)
  const cod=orders.filter(r=>(r.payment||'').toUpperCase()==='COD')
  const cityMap:Record<string,number>={}, dayMap:Record<string,any>={}, hourMap:Record<string,number>={}
  const valMap:Record<string,number>={'0-500':0,'500-1k':0,'1k-1.5k':0,'1.5k-2k':0,'2k+':0}
  orders.forEach(r=>{
    const c=(r.location||'N/A').trim(); if(!isRTO(c))cityMap[c]=(cityMap[c]||0)+1
    if(r.dateYMD){
      if(!dayMap[r.dateYMD])dayMap[r.dateYMD]={orders:0,revenue:0,cod:0,prepaid:0}
      dayMap[r.dateYMD].orders++;dayMap[r.dateYMD].revenue+=r.valueNum||0
      ;(r.payment||'').toUpperCase()==='COD'?dayMap[r.dateYMD].cod++:dayMap[r.dateYMD].prepaid++
    }
    if(r.orderTime&&r.orderTime!=='N/A'){const h=r.orderTime.slice(0,2)+'h';hourMap[h]=(hourMap[h]||0)+1}
    const v=r.valueNum||0
    if(v<500)valMap['0-500']++;else if(v<1000)valMap['500-1k']++;
    else if(v<1500)valMap['1k-1.5k']++;else if(v<2000)valMap['1.5k-2k']++;else valMap['2k+']++
  })
  const topCities=Object.entries(cityMap).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([city,count])=>({city,count}))
  const daily=Object.keys(dayMap).sort().map(k=>({date:k,...dayMap[k]}))
  const hours=Object.entries(hourMap).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([h,c])=>({hour:h,count:c}))
  let velocity='stable'
  if(daily.length>=6){const rec=daily.slice(-3).reduce((s,d)=>s+d.orders,0)/3,old=daily.slice(0,3).reduce((s,d)=>s+d.orders,0)/3;if(rec>old*1.15)velocity='growing';else if(rec<old*0.85)velocity='shrinking'}
  return{totalOrders:N,totalRevenue:rev,avgOrderVal:rev/N,codCount:cod.length,prepaidCount:N-cod.length,codPct:Math.round((cod.length/N)*100),topCities,daily,hours,valueBuckets:valMap,velocity}
}

// ── Downloads ─────────────────────────────────────────
const sortOrders=(orders:Order[])=>[...orders].sort((a,b)=>(a.dateYMD||'').localeCompare(b.dateYMD||'')||(a.orderTime||'').localeCompare(b.orderTime||''))
const fmtRs=(n:number)=>'Rs.'+Math.round(n).toLocaleString('en-IN')
const e=(v:any)=>`"${String(v??'').replace(/"/g,'""')}"`
const f=(n:number)=>'Rs.'+Number(n||0).toFixed(2)

function buildCSV(orders:Order[]):string {
  let s='Order ID,Date,Time,Value,Payment,Status,Location,Pincode\n'
  sortOrders(orders).forEach(r=>s+=`${e(r.orderId)},${e(r.orderDate)},${e(r.orderTime)},${e(r.value)},${e(r.payment)},${e(r.status)},${e(r.location)},${e(r.pincode)}\n`)
  return s
}
function buildReport(orders:Order[],brandName:string,dateRange:string):string {
  const a=buildAnalytics(orders);if(!a)return''
  const fd=(ymd:string)=>{const[y,m,d]=ymd.split('-');return new Date(+y,+m-1,+d).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'})}
  let s=`BRAND INTELLIGENCE REPORT\nBrand,${e(brandName)}\nDate Range,${e(dateRange)}\nGenerated,${new Date().toLocaleString('en-IN')}\n\n`
  s+=`SUMMARY\nTotal Orders,${a.totalOrders}\nRevenue,${f(a.totalRevenue)}\nAvg Value,${f(a.avgOrderVal)}\nCOD,${a.codCount} (${a.codPct}%)\nPrepaid,${a.prepaidCount}\nVelocity,${a.velocity}\n\n`
  s+='TOP CITIES\nCity,Orders\n';a.topCities.forEach(c=>s+=`${e(c.city)},${c.count}\n`)
  s+='\nPEAK HOURS\nHour,Orders\n';a.hours.forEach(h=>s+=`${e(h.hour)},${h.count}\n`)
  s+='\nVALUE DISTRIBUTION\nBucket,Orders\n';Object.entries(a.valueBuckets).forEach(([k,v])=>s+=`${e('Rs.'+k)},${v}\n`)
  s+='\nDAILY BREAKDOWN\nDate,Orders,Revenue,COD,Prepaid\n'
  a.daily.forEach(d=>s+=`${e(fd(d.date))},${d.orders},${f(d.revenue)},${d.cod},${d.prepaid}\n`)
  s+='\nFULL ORDER LIST\nOrder ID,Date,Time,Value,Payment,Status,Location,Pincode\n'
  sortOrders(orders).forEach(r=>s+=`${e(r.orderId)},${e(r.orderDate)},${e(r.orderTime)},${e(r.value)},${e(r.payment)},${e(r.status)},${e(r.location)},${e(r.pincode)}\n`)
  return s
}
function dlFile(content:string,filename:string){const a=document.createElement('a');a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(content);a.download=filename;a.click()}
function todayStr(){const d=new Date();return`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
function yestStr(){const d=new Date();d.setDate(d.getDate()-1);return`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}

// ═══════════════════════════════════════════════════════
//  MAIN APP
// ═══════════════════════════════════════════════════════
export default function App() {
  const [light,setLight]=useState(false)
  const [brands,setBrands]=useState<Brand[]>([])
  const [activeBrand,setActiveBrand]=useState<Brand|null>(null)
  const [tab,setTab]=useState<'date'|'manual'|'analytics'|'history'|'settings'>('date')
  const [runs,setRuns]=useState<ScanRun[]>([])
  const [lastOrders,setLastOrders]=useState<Order[]>([])
  const [analytics,setAnalytics]=useState<Analytics|null>(null)
  const [isScanning,setIsScanning]=useState(false)
  const [scanLog,setScanLog]=useState<Array<{msg:string,cls:string}>>([{msg:'Select a date range and click Find & Scrape.',cls:''}])
  const [progress,setProgress]=useState({done:0,total:0,found:0})
  const [startedAt,setStartedAt]=useState(0)
  const [showAddBrand,setShowAddBrand]=useState(false)
  const abortRef=useRef<AbortController|null>(null)
  const logRef=useRef<HTMLDivElement>(null)

  // Theme
  useEffect(()=>{
    const saved=LS.get('lightMode',false);setLight(saved)
    document.documentElement.setAttribute('data-theme',saved?'light':'dark')
  },[])
  function toggleTheme(){const n=!light;setLight(n);LS.set('lightMode',n);document.documentElement.setAttribute('data-theme',n?'light':'dark')}

  useEffect(()=>{
    const saved=LS.get<Brand[]>('brands',[]);setBrands(saved)
    const aid=LS.get('activeBrandId','');const b=saved.find((x:Brand)=>x.id===aid)||saved[0]||null
    if(b){setActiveBrand(b);loadRunsForBrand(b)}
  },[])

  useEffect(()=>{if(logRef.current)logRef.current.scrollTop=logRef.current.scrollHeight},[scanLog])

  function loadRunsForBrand(b:Brand){
    const r=LS.get<ScanRun[]>(`runs_${b.id}`,[]);setRuns(r)
    if(r.length>0){setLastOrders(r[0].orders);setAnalytics(buildAnalytics(r[0].orders))}
    else{setLastOrders([]);setAnalytics(null)}
  }

  function selectBrand(b:Brand){setActiveBrand(b);LS.set('activeBrandId',b.id);loadRunsForBrand(b)}
  function deleteBrand(id:string){
    if(!confirm('Delete this brand and all its data?'))return
    const u=brands.filter(b=>b.id!==id);setBrands(u);LS.set('brands',u);localStorage.removeItem(`runs_${id}`)
    const next=u[0]||null;setActiveBrand(next);if(next)loadRunsForBrand(next);else{setRuns([]);setLastOrders([]);setAnalytics(null)}
  }

  const addLog=useCallback((msg:string,cls:string='')=>setScanLog(p=>[...p.slice(-300),{msg,cls}]),[])

  async function startScan(fromDate:string,toDate:string,concurrency:number,startId?:number,endId?:number,useAuto?:boolean,stopAfter?:number){
    if(!activeBrand||isScanning)return
    setIsScanning(true);setScanLog([]);setProgress({done:0,total:0,found:0});setStartedAt(Date.now());ordersRef.current=[]
    const ab=new AbortController();abortRef.current=ab
    const orders:Order[]=[]
    try{
      const body:any={brandId:activeBrand.id,subdomain:activeBrand.subdomain,slug:activeBrand.slug,
        anchorId:activeBrand.anchorId,anchorDate:activeBrand.anchorDate,avgPerDay:activeBrand.avgPerDay,
        regressionPoints:activeBrand.regressionPoints,concurrency}
      if(startId!=null){body.mode='manual';body.startId=startId;body.endId=endId;body.useAuto=useAuto;body.stopAfter=stopAfter}
      else{body.mode='date';body.fromDate=fromDate;body.toDate=toDate}

      const res=await fetch('/api/scan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:ab.signal})
      if(!res.ok||!res.body)throw new Error('Scan failed to start')
      const reader=res.body.getReader();const decoder=new TextDecoder();let buf=''
      while(true){
        const{done,value}=await reader.read();if(done)break
        buf+=decoder.decode(value,{stream:true})
        const lines=buf.split('\n');buf=lines.pop()||''
        for(const line of lines){
          if(!line.startsWith('data: '))continue
          try{
            const d=JSON.parse(line.slice(6))
            if(d.type==='log')addLog(d.msg,d.cls||'')
            else if(d.type==='order'){orders.push(d.order);ordersRef.current=orders}
            else if(d.type==='progress')setProgress({done:d.done,total:d.total,found:d.found})
            else if(d.type==='start')setProgress(p=>({...p,total:d.total}))
            else if(d.type==='error')addLog('⚠ '+d.msg,'err')
            else if(d.type==='done'){
              const dates=orders.map(r=>r.dateYMD).filter(Boolean).sort()
              const dateLabel=dates.length===0?`${fromDate||'manual'} to ${toDate||''}`:dates[0]===dates[dates.length-1]?dates[0]!:`${dates[0]} to ${dates[dates.length-1]}`
              const run:ScanRun={runId:d.runId||Date.now().toString(),dateRange:dateLabel,found:orders.length,scanned:d.scanned||0,orders,createdAt:new Date().toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'})}
              const updated=[run,...LS.get<ScanRun[]>(`runs_${activeBrand.id}`,[])].slice(0,50)
              LS.set(`runs_${activeBrand.id}`,updated);setRuns(updated);setLastOrders(orders);setAnalytics(buildAnalytics(orders))
              // Update regression
              const byDate:Record<string,{min:number,max:number}>={}
              orders.forEach(o=>{if(!o.dateYMD)return;if(!byDate[o.dateYMD])byDate[o.dateYMD]={min:o.orderId,max:o.orderId};else{byDate[o.dateYMD].min=Math.min(byDate[o.dateYMD].min,o.orderId);byDate[o.dateYMD].max=Math.max(byDate[o.dateYMD].max,o.orderId)}})
              const newPts=Object.entries(byDate).map(([date,{min,max}])=>({date,id:Math.round((min+max)/2)}))
              const existing=activeBrand.regressionPoints||[]
              const merged=Object.values(Object.fromEntries([...existing,...newPts].map(p=>[p.date,p]))).sort((a:any,b:any)=>a.date.localeCompare(b.date))
              const regPts=merged.slice(-30) as Array<{date:string,id:number}>
              let newAvg=activeBrand.avgPerDay
              if(merged.length>=2){const ff=merged[0] as any,ll=merged[merged.length-1] as any;const days=(new Date(ll.date+' 00:00:00').getTime()-new Date(ff.date+' 00:00:00').getTime())/86400000;if(days>0)newAvg=Math.min(500,Math.max(1,Math.ceil((ll.id-ff.id)/days)))}
              const u2={...activeBrand,regressionPoints:regPts,avgPerDay:newAvg}
              setActiveBrand(u2);const ab2=brands.map(b=>b.id===activeBrand.id?u2:b);setBrands(ab2);LS.set('brands',ab2)
              addLog(`✓ Done: ${dateLabel} — ${orders.length} orders`,'ok')
            }
          }catch{}
        }
      }
    }catch(err:any){if(err.name!=='AbortError')addLog('Error: '+err.message,'err')}
    finally{setIsScanning(false)}
  }

  // Keep a ref to orders collected so far so stopScan can save them
  const ordersRef = useRef<Order[]>([])

  function stopScan(){
    abortRef.current?.abort()
    setIsScanning(false)
    addLog('Scan stopped.','info')
    // Save whatever was found so far
    if(ordersRef.current.length>0&&activeBrand){
      const orders=ordersRef.current
      setLastOrders(orders)
      setAnalytics(buildAnalytics(orders))
      const dates=orders.map(r=>r.dateYMD).filter(Boolean).sort()
      const dateLabel=dates.length===0?'partial':dates[0]===dates[dates.length-1]?dates[0]!+' (partial)':`${dates[0]} to ${dates[dates.length-1]} (partial)`
      const run:ScanRun={runId:Date.now().toString(),dateRange:dateLabel,found:orders.length,scanned:progress.done,orders,createdAt:new Date().toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'})}
      const updated=[run,...LS.get<ScanRun[]>(`runs_${activeBrand.id}`,[])].slice(0,50)
      LS.set(`runs_${activeBrand.id}`,updated);setRuns(updated)
      addLog(`Saved ${orders.length} orders found so far`,'info')
    }
  }

  const eta=(()=>{
    if(!startedAt||!progress.done||!progress.total)return''
    const elapsed=(Date.now()-startedAt)/1000,rate=progress.done/elapsed,rem=rate>0?(progress.total-progress.done)/rate:0
    if(rem>=3600)return`${Math.floor(rem/3600)}h ${Math.floor((rem%3600)/60)}m`
    if(rem>=60)return`${Math.floor(rem/60)}m ${Math.floor(rem%60)}s`
    return`${Math.floor(rem)}s`
  })()

  // CSS vars
  const css=light?{
    '--bg':'#f5f5f0','--surface':'#ffffff','--surface2':'#efefea','--border':'#ddd',
    '--accent':'#008844','--warn':'#cc5500','--text':'#111','--muted':'#888','--red':'#cc2222'
  }:{
    '--bg':'#0d0d0d','--surface':'#161616','--surface2':'#1e1e1e','--border':'#252525',
    '--accent':'#00ff88','--warn':'#ff6b35','--text':'#e8e8e8','--muted':'#4a4a4a','--red':'#ff4444'
  }

  return (
    <div style={{...(css as any),background:'var(--bg)',color:'var(--text)',minHeight:'100vh',transition:'all .2s'}}>
    <div style={{maxWidth:920,margin:'0 auto',padding:'20px 16px'}}>

      {/* Header */}
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:18}}>
        <div>
          <div style={{fontSize:13,fontWeight:700,letterSpacing:'.1em',color:'var(--accent)',textTransform:'uppercase'}}>Shiprocket Order Scrapper</div>
          <div style={{fontSize:9,color:'var(--muted)',marginTop:2}}>by RahulJ · PRO v5.0 · Free Web Edition</div>
        </div>
        <div style={{display:'flex',gap:8}}>
          <button onClick={toggleTheme} style={{background:'var(--surface)',border:'1px solid var(--border)',color:'var(--text)',width:30,height:30,borderRadius:6,fontSize:14,display:'flex',alignItems:'center',justifyContent:'center'}}>
            {light?'🌙':'☀️'}
          </button>
          <button onClick={()=>setShowAddBrand(true)} style={{background:'var(--accent)',color:'#000',border:'none',padding:'7px 14px',borderRadius:6,fontSize:11,fontWeight:700,letterSpacing:'.06em'}}>
            + ADD BRAND
          </button>
        </div>
      </div>

      {/* Brand selector */}
      {brands.length>0&&(
        <div style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:8,padding:'8px 12px',marginBottom:12,display:'flex',alignItems:'center',gap:10}}>
          <span style={{fontSize:9,color:'var(--muted)',letterSpacing:'.08em',textTransform:'uppercase',flexShrink:0}}>Brand</span>
          <select value={activeBrand?.id||''} onChange={e=>{const b=brands.find(x=>x.id===e.target.value);if(b)selectBrand(b)}}
            style={{flex:1,border:'none',background:'transparent',color:'var(--text)',fontSize:13,fontWeight:700,padding:'2px 0',outline:'none',fontFamily:'inherit'}}>
            {brands.map(b=><option key={b.id} value={b.id} style={{background:'var(--surface)'}}>{b.name} ({b.subdomain}.shiprocket.co)</option>)}
          </select>
          <span style={{fontSize:9,color:'var(--muted)',flexShrink:0}}>~{activeBrand?.avgPerDay}/day · {activeBrand?.regressionPoints?.length||0} cal pts</span>
        </div>
      )}

      {/* No brand */}
      {brands.length===0&&!showAddBrand&&(
        <div style={{textAlign:'center',padding:'60px 20px',color:'var(--muted)'}}>
          <div style={{fontSize:32,marginBottom:16}}>📦</div>
          <div style={{fontSize:13,marginBottom:8}}>No brands added yet</div>
          <div style={{fontSize:11,lineHeight:2}}>Click <span style={{color:'var(--accent)'}}>+ ADD BRAND</span> to get started</div>
        </div>
      )}

      {/* Add Brand */}
      {showAddBrand&&<AddBrandForm onAdd={brand=>{const u=[...brands,brand];setBrands(u);LS.set('brands',u);selectBrand(brand);setShowAddBrand(false)}} onCancel={()=>setShowAddBrand(false)}/>}

      {/* Main */}
      {activeBrand&&!showAddBrand&&(
        <>
          <DashboardStrip runs={runs}/>
          {/* Tabs */}
          <div style={{display:'flex',borderBottom:'1px solid var(--border)',marginBottom:16,overflowX:'auto'}}>
            {(['date','manual','analytics','history','settings'] as const).map(t=>(
              <button key={t} onClick={()=>setTab(t)} style={{background:'none',border:'none',borderBottom:`2px solid ${tab===t?'var(--accent)':'transparent'}`,color:tab===t?'var(--accent)':'var(--muted)',fontSize:10,fontWeight:700,letterSpacing:'.08em',textTransform:'uppercase',padding:'8px 14px',cursor:'pointer',marginBottom:-1,whiteSpace:'nowrap',fontFamily:'inherit'}}>
                {t==='date'?'By Date':t.charAt(0).toUpperCase()+t.slice(1)}
              </button>
            ))}
          </div>
          {tab==='date'&&<DateTab activeBrand={activeBrand} isScanning={isScanning} scanLog={scanLog} progress={progress} eta={eta} logRef={logRef} lastOrders={lastOrders} onStart={(f,t,c)=>startScan(f,t,c)} onStop={stopScan}/>}
          {tab==='manual'&&<ManualTab activeBrand={activeBrand} isScanning={isScanning} scanLog={scanLog} progress={progress} eta={eta} logRef={logRef} lastOrders={lastOrders} onStart={startScan} onStop={stopScan}/>}
          {tab==='analytics'&&<AnalyticsTab analytics={analytics}/>}
          {tab==='history'&&<HistoryTab runs={runs} brandName={activeBrand.name} onClear={()=>{localStorage.removeItem(`runs_${activeBrand.id}`);setRuns([]);setLastOrders([]);setAnalytics(null)}}/>}
          {tab==='settings'&&<SettingsTab brands={brands} activeBrand={activeBrand} runs={runs} onDelete={deleteBrand} onUpdate={(u:Brand)=>{const all=brands.map(b=>b.id===u.id?u:b);setBrands(all);LS.set('brands',all);setActiveBrand(u)}}/>}
        </>
      )}
    </div>
    </div>
  )
}

// ── Add Brand ─────────────────────────────────────────
function AddBrandForm({onAdd,onCancel}:{onAdd:(b:Brand)=>void,onCancel:()=>void}){
  const [url,setUrl]=useState('');const [name,setName]=useState('');const [sub,setSub]=useState('')
  const [oid,setOid]=useState('');const [date,setDate]=useState('');const [status,setStatus]=useState<{msg:string,ok:boolean}|null>(null);const [loading,setLoading]=useState(false)
  function handleUrl(v:string){setUrl(v);const m=v.match(/https?:\/\/([^.]+)\.shiprocket\.co/);if(m){setSub(m[1]);if(!name)setName(m[1].charAt(0).toUpperCase()+m[1].slice(1))}}
  async function add(){
    if(!name||!sub||!oid||!date){setStatus({msg:'Fill all fields',ok:false});return}
    setLoading(true);setStatus(null)
    const detect=await fetch('/api/detect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subdomain:sub,orderId:oid})})
    const d=await detect.json()
    if(!d.ok){setStatus({msg:d.error||'Cannot detect slug',ok:false});setLoading(false);return}
    const est=await fetch('/api/estimate-avg',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subdomain:sub,anchorId:parseInt(oid),slug:d.slug})})
    const ev=await est.json()
    onAdd({id:Date.now().toString(),name,subdomain:sub,slug:d.slug,companyName:d.companyName,anchorId:parseInt(oid),anchorDate:date,avgPerDay:ev.avgPerDay||30,regressionPoints:[]})
    setLoading(false)
  }
  const inp={width:'100%',padding:'8px 10px',fontSize:12,background:'var(--surface)',border:'1px solid var(--border)',color:'var(--text)',borderRadius:6,fontFamily:'inherit',outline:'none'}
  const lbl={fontSize:9,color:'var(--muted)',letterSpacing:'.08em',textTransform:'uppercase' as const,display:'block' as const,marginBottom:4}
  return(
    <div style={{background:'var(--surface)',border:'1px solid var(--accent)',borderRadius:10,padding:20,marginBottom:16}}>
      <div style={{fontSize:11,fontWeight:700,color:'var(--accent)',letterSpacing:'.08em',textTransform:'uppercase',marginBottom:14}}>+ Add New Brand</div>
      <div style={{display:'grid',gap:10}}>
        <div><label style={lbl}>Shiprocket URL</label><input value={url} onChange={e=>handleUrl(e.target.value)} placeholder="https://everlasting.shiprocket.co/" style={inp}/></div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
          <div><label style={lbl}>Brand Name</label><input value={name} onChange={e=>setName(e.target.value)} placeholder="e.g. Everlasting" style={inp}/></div>
          <div><label style={lbl}>Subdomain</label><input value={sub} onChange={e=>setSub(e.target.value)} placeholder="e.g. everlasting" style={inp}/></div>
        </div>
        <div style={{background:'var(--surface2)',border:'1px solid var(--border)',borderRadius:6,padding:'8px 10px',fontSize:9,color:'var(--warn)'}}>
          ⚠ Use <b>order ID</b> (e.g. 61083) — NOT tracking ID (like 76806566966 from courier)
        </div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
          <div><label style={lbl}>One Known Order ID</label><input type="number" value={oid} onChange={e=>setOid(e.target.value)} placeholder="e.g. 437470" style={inp}/></div>
          <div><label style={lbl}>That Order's Date</label><input type="date" value={date} onChange={e=>setDate(e.target.value)} style={inp}/></div>
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

// ── Dashboard ─────────────────────────────────────────
function DashboardStrip({runs}:{runs:ScanRun[]}){
  const all=runs.flatMap(r=>r.orders)
  const td=todayStr(),yd=yestStr(),pfx=td.slice(0,7)
  const tO=all.filter(o=>o.dateYMD===td),yO=all.filter(o=>o.dateYMD===yd),mO=all.filter(o=>o.dateYMD?.startsWith(pfx))
  const card=(label:string,val:string,sub:string)=>(
    <div style={{flex:1,background:'var(--surface)',border:'1px solid var(--border)',borderRadius:8,padding:'10px 12px',minWidth:0}}>
      <div style={{fontSize:8,color:'var(--muted)',textTransform:'uppercase',letterSpacing:'.08em',marginBottom:4}}>{label}</div>
      <div style={{fontSize:15,fontWeight:700,color:'var(--accent)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{val}</div>
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

// ── Scan Controls (shared by Date + Manual tabs) ──────
function ScanControls({isScanning,progress,eta,logRef,scanLog,lastOrders,activeBrand,onStop,onCSV,onReport}:any){
  const pct=progress.total?Math.min(progress.done/progress.total*100,100):0
  return(
    <>
      {isScanning&&(
        <>
          <div style={{marginBottom:10}}>
            <div style={{display:'flex',justifyContent:'space-between',fontSize:10,color:'var(--muted)',marginBottom:5}}>
              <span>{progress.done}/{progress.total||'?'} — <b style={{color:'var(--accent)'}}>{progress.found} found</b></span>
              <span style={{color:'var(--accent)'}}>{eta?`ETA: ${eta}`:'Calculating...'}</span>
            </div>
            <div style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:4,height:6,overflow:'hidden'}}>
              <div style={{height:'100%',background:'var(--accent)',width:`${pct}%`,transition:'width .3s',borderRadius:4}}/>
            </div>
          </div>
          <button onClick={onStop} style={{width:'100%',background:'var(--surface)',color:'var(--red)',border:'1px solid var(--red)',padding:10,borderRadius:8,fontSize:11,fontWeight:700,marginBottom:12,fontFamily:'inherit',cursor:'pointer'}}>■ STOP</button>
        </>
      )}
      <div ref={logRef} style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:6,padding:10,minHeight:80,maxHeight:220,overflowY:'auto',fontSize:10,lineHeight:1.8,marginBottom:12}}>
        {scanLog.map((l:any,i:number)=>(
          <div key={i} style={{color:l.cls==='ok'?'var(--accent)':l.cls==='err'?'var(--red)':l.cls==='info'?'var(--warn)':'var(--muted)'}}>{l.msg}</div>
        ))}
      </div>
      {lastOrders.length>0&&!isScanning&&(
        <div style={{display:'flex',gap:8}}>
          <button onClick={onCSV} style={{flex:1,background:'var(--surface)',border:'1px solid var(--border)',color:'var(--text)',padding:9,borderRadius:6,fontSize:11,fontWeight:700,fontFamily:'inherit',cursor:'pointer'}}>↓ CSV ({lastOrders.length})</button>
          <button onClick={onReport} style={{flex:1,background:'var(--surface)',border:'1px solid var(--border)',color:'var(--text)',padding:9,borderRadius:6,fontSize:11,fontWeight:700,fontFamily:'inherit',cursor:'pointer'}}>↓ Full Report</button>
          <button onClick={()=>{
            const a=buildAnalytics(lastOrders);if(!a)return
            const top=a.topCities[0]
            const txt=`📦 *${activeBrand.name}*\nOrders: *${a.totalOrders}* | Revenue: *${fmtRs(a.totalRevenue)}*\nCOD: ${a.codCount} (${a.codPct}%) | Avg: ${fmtRs(a.avgOrderVal)}\n`+(top?`🏆 ${top.city} (${top.count})\n`:'')+`📈 ${a.velocity}`
            navigator.clipboard.writeText(txt).then(()=>alert('Copied to clipboard!'))
          }} style={{flex:1,background:'var(--surface)',border:'1px solid #25d366',color:'#25d366',padding:9,borderRadius:6,fontSize:11,fontWeight:700,fontFamily:'inherit',cursor:'pointer'}}>📱 WA</button>
        </div>
      )}
    </>
  )
}

// ── Date Tab ──────────────────────────────────────────
function DateTab({activeBrand,isScanning,scanLog,progress,eta,logRef,lastOrders,onStart,onStop}:any){
  const [from,setFrom]=useState(yestStr());const [to,setTo]=useState(todayStr());const [conc,setConc]=useState('5')
  const inp={width:'100%',padding:'8px 10px',fontSize:13,background:'var(--surface)',border:'1px solid var(--border)',color:'var(--text)',borderRadius:6,fontFamily:'inherit',outline:'none'}
  const lbl={fontSize:9,color:'var(--muted)',letterSpacing:'.08em',textTransform:'uppercase' as const,display:'block' as const,marginBottom:4}
  return(
    <div>
      <div style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:6,padding:'8px 12px',marginBottom:12,fontSize:9,color:'var(--muted)',lineHeight:1.8}}>
        Anchor: <span style={{color:'var(--accent)'}}>#{activeBrand.anchorId} = {activeBrand.anchorDate}</span> · slug: <span style={{color:'var(--accent)'}}>{activeBrand.slug}</span> · ~{activeBrand.avgPerDay}/day · {activeBrand.regressionPoints?.length||0} cal pts
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
      {!isScanning&&(
        <button onClick={()=>onStart(from,to,parseInt(conc))} style={{width:'100%',background:'var(--accent)',color:'#000',border:'none',padding:11,borderRadius:8,fontSize:12,fontWeight:700,letterSpacing:'.06em',textTransform:'uppercase',marginBottom:12,fontFamily:'inherit',cursor:'pointer'}}>
          🔍 FIND &amp; SCRAPE
        </button>
      )}
      <ScanControls isScanning={isScanning} progress={progress} eta={eta} logRef={logRef} scanLog={scanLog} lastOrders={lastOrders} activeBrand={activeBrand} onStop={onStop}
        onCSV={()=>dlFile(buildCSV(lastOrders),`${activeBrand.name}_${from}_to_${to}.csv`)}
        onReport={()=>dlFile(buildReport(lastOrders,activeBrand.name,`${from} to ${to}`),`${activeBrand.name}_report_${from}_to_${to}.csv`)}/>
    </div>
  )
}

// ── Manual Tab ────────────────────────────────────────
function ManualTab({activeBrand,isScanning,scanLog,progress,eta,logRef,lastOrders,onStart,onStop}:any){
  const [startId,setStartId]=useState('');const [endId,setEndId]=useState('');const [useAuto,setUseAuto]=useState(false)
  const [stopAfter,setStopAfter]=useState('100');const [conc,setConc]=useState('5')
  const inp={width:'100%',padding:'8px 10px',fontSize:12,background:'var(--surface)',border:'1px solid var(--border)',color:'var(--text)',borderRadius:6,fontFamily:'inherit',outline:'none'}
  const lbl={fontSize:9,color:'var(--muted)',letterSpacing:'.08em',textTransform:'uppercase' as const,display:'block' as const,marginBottom:4}
  return(
    <div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:10}}>
        <div><label style={lbl}>Start ID</label><input type="number" value={startId} onChange={e=>setStartId(e.target.value)} placeholder="e.g. 61000" style={inp}/></div>
        <div><label style={lbl}>End ID</label><input type="number" value={endId} onChange={e=>setEndId(e.target.value)} placeholder="e.g. 62000" disabled={useAuto} style={{...inp,opacity:useAuto?.4:1}}/></div>
      </div>
      <div style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:6,padding:'10px 12px',marginBottom:10,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
        <label style={{fontSize:10,color:'var(--muted)'}}>Auto-detect end (stop after N consecutive misses)</label>
        <input type="checkbox" checked={useAuto} onChange={e=>setUseAuto(e.target.checked)} style={{accentColor:'var(--accent)',width:16,height:16}}/>
      </div>
      {useAuto&&(
        <div style={{marginBottom:10}}>
          <label style={lbl}>Stop after N misses</label>
          <div style={{display:'flex',alignItems:'center',gap:8}}>
            <input type="number" value={stopAfter} onChange={e=>setStopAfter(e.target.value)} style={{...inp,width:100}}/>
            <span style={{fontSize:9,color:'var(--muted)'}}>Tip: use {parseInt(conc)*50}+ at {conc}x concurrency (rate limits look like misses)</span>
          </div>
        </div>
      )}
      <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:12,fontSize:11,color:'var(--muted)'}}>
        <span>Concurrent fetches</span>
        <select value={conc} onChange={e=>setConc(e.target.value)} style={{...inp,width:'auto',padding:'5px 8px',fontSize:11}}>
          {['3','5','8','10'].map(v=><option key={v} value={v}>{v}</option>)}
        </select>
      </div>
      {!isScanning&&(
        <button onClick={()=>{
          if(!startId){alert('Enter a start ID');return}
          if(!useAuto&&!endId){alert('Enter end ID or enable auto-detect');return}
          onStart('','',parseInt(conc),parseInt(startId),endId?parseInt(endId):undefined,useAuto,parseInt(stopAfter))
        }} style={{width:'100%',background:'var(--accent)',color:'#000',border:'none',padding:11,borderRadius:8,fontSize:12,fontWeight:700,letterSpacing:'.06em',textTransform:'uppercase',marginBottom:12,fontFamily:'inherit',cursor:'pointer'}}>
          ▶ START MANUAL SCRAPE
        </button>
      )}
      <ScanControls isScanning={isScanning} progress={progress} eta={eta} logRef={logRef} scanLog={scanLog} lastOrders={lastOrders} activeBrand={activeBrand} onStop={onStop}
        onCSV={()=>dlFile(buildCSV(lastOrders),`${activeBrand.name}_manual_${startId}.csv`)}
        onReport={()=>dlFile(buildReport(lastOrders,activeBrand.name,`manual ${startId}–${endId}`),`${activeBrand.name}_manual_report.csv`)}/>
    </div>
  )
}

// ── Analytics Tab ─────────────────────────────────────
function AnalyticsTab({analytics}:{analytics:Analytics|null}){
  if(!analytics)return<div style={{textAlign:'center',padding:'40px 20px',color:'var(--muted)',fontSize:11}}>Run a scan first to see analytics.</div>
  const a=analytics
  return(
    <div style={{display:'grid',gap:12}}>
      <div style={{display:'grid',gridTemplateColumns:'repeat(2,1fr)',gap:8}}>
        {[['Total Orders',String(a.totalOrders),''],['Total Revenue',fmtRs(a.totalRevenue),''],
          ['Avg Order Value',fmtRs(a.avgOrderVal),`Trend: ${a.velocity}`],['COD vs Prepaid',`${a.codCount} / ${a.prepaidCount}`,`${a.codPct}% COD`]
        ].map(([l,v,s])=>(
          <div key={l} style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:8,padding:'10px 12px'}}>
            <div style={{fontSize:8,color:'var(--muted)',textTransform:'uppercase',letterSpacing:'.08em',marginBottom:4}}>{l}</div>
            <div style={{fontSize:16,fontWeight:700,color:'var(--accent)'}}>{v}</div>
            {s&&<div style={{fontSize:9,color:'var(--muted)',marginTop:2}}>{s}</div>}
          </div>
        ))}
      </div>
      <Sec title="Top Cities (excl. courier hubs)">{a.topCities.slice(0,8).map(c=><Row key={c.city} label={c.city} value={String(c.count)}/>)}</Sec>
      <Sec title="Peak Order Hours">
        <div style={{display:'flex',flexWrap:'wrap',gap:6}}>
          {a.hours.map(h=><div key={h.hour} style={{background:'var(--surface2)',border:'1px solid var(--border)',borderRadius:4,padding:'4px 10px',fontSize:10}}><b style={{color:'var(--accent)'}}>{h.hour}</b><span style={{color:'var(--muted)',marginLeft:6}}>{h.count}</span></div>)}
        </div>
      </Sec>
      <Sec title="Order Value Distribution">{Object.entries(a.valueBuckets).map(([k,v])=><Row key={k} label={`Rs.${k}`} value={String(v)}/>)}</Sec>
      <Sec title="Daily Breakdown">
        <div style={{overflowX:'auto'}}>
          <table style={{width:'100%',fontSize:10,borderCollapse:'collapse'}}>
            <thead><tr>{['Date','Orders','Revenue','COD','Prepaid'].map(h=><th key={h} style={{textAlign:h==='Date'?'left':'right',padding:'4px 8px',borderBottom:'1px solid var(--border)',color:'var(--muted)',fontWeight:600}}>{h}</th>)}</tr></thead>
            <tbody>{a.daily.map(d=>(
              <tr key={d.date} style={{borderBottom:'1px solid var(--border)'}}>
                <td style={{padding:'4px 8px',color:'var(--text)'}}>{d.date}</td>
                <td style={{padding:'4px 8px',color:'var(--accent)',textAlign:'right',fontWeight:700}}>{d.orders}</td>
                <td style={{padding:'4px 8px',color:'var(--muted)',textAlign:'right'}}>{fmtRs(d.revenue)}</td>
                <td style={{padding:'4px 8px',color:'var(--muted)',textAlign:'right'}}>{d.cod}</td>
                <td style={{padding:'4px 8px',color:'var(--muted)',textAlign:'right'}}>{d.prepaid}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </Sec>
    </div>
  )
}
function Sec({title,children}:{title:string,children:React.ReactNode}){return<div style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:8,padding:'10px 12px'}}><div style={{fontSize:8,color:'var(--muted)',textTransform:'uppercase',letterSpacing:'.08em',marginBottom:8}}>{title}</div>{children}</div>}
function Row({label,value}:{label:string,value:string}){return<div style={{display:'flex',justifyContent:'space-between',fontSize:11,padding:'3px 0',borderBottom:'1px solid var(--border)'}}><span style={{color:'var(--text)'}}>{label}</span><span style={{color:'var(--accent)',fontWeight:700}}>{value}</span></div>}

// ── History Tab ───────────────────────────────────────
function HistoryTab({runs,brandName,onClear}:{runs:ScanRun[],brandName:string,onClear:()=>void}){
  if(!runs.length)return<div style={{textAlign:'center',padding:'40px 20px',color:'var(--muted)',fontSize:11}}>No runs yet.</div>
  return(
    <div>
      {runs.map(r=>{const a=buildAnalytics(r.orders);return(
        <div key={r.runId} style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:8,padding:12,marginBottom:10}}>
          <div style={{display:'flex',justifyContent:'space-between',marginBottom:6}}>
            <span style={{color:'var(--accent)',fontWeight:700,fontSize:12}}>{r.dateRange}</span>
            <span style={{color:'var(--muted)',fontSize:9}}>{r.createdAt}</span>
          </div>
          <div style={{display:'flex',gap:16,fontSize:10,marginBottom:8,flexWrap:'wrap'}}>
            <span style={{color:'var(--muted)'}}>Found: <b style={{color:'var(--text)'}}>{r.found}</b></span>
            {a&&<><span style={{color:'var(--muted)'}}>Rev: <b style={{color:'var(--text)'}}>{fmtRs(a.totalRevenue)}</b></span><span style={{color:'var(--muted)'}}>COD: <b style={{color:'var(--text)'}}>{a.codPct}%</b></span><span style={{color:'var(--muted)'}}>Avg: <b style={{color:'var(--text)'}}>{fmtRs(a.avgOrderVal)}</b></span></>}
          </div>
          {a&&a.topCities.length>0&&<div style={{fontSize:9,color:'var(--muted)',marginBottom:8}}>{a.topCities.slice(0,4).map(c=>`${c.city} (${c.count})`).join(' · ')} · {a.velocity}</div>}
          <div style={{display:'flex',gap:6}}>
            <button onClick={()=>dlFile(buildCSV(r.orders),`${brandName}_${r.dateRange}.csv`)} style={{flex:1,background:'none',border:'1px solid var(--border)',color:'var(--text)',padding:7,borderRadius:6,fontSize:10,fontWeight:700,fontFamily:'inherit',cursor:'pointer'}}>↓ CSV</button>
            <button onClick={()=>dlFile(buildReport(r.orders,brandName,r.dateRange),`${brandName}_report_${r.dateRange}.csv`)} style={{flex:1,background:'none',border:'1px solid var(--border)',color:'var(--text)',padding:7,borderRadius:6,fontSize:10,fontWeight:700,fontFamily:'inherit',cursor:'pointer'}}>↓ Report</button>
          </div>
        </div>
      )})}
      <button onClick={()=>{if(confirm('Clear all history?'))onClear()}} style={{width:'100%',background:'none',border:'1px solid var(--border)',color:'var(--muted)',padding:8,borderRadius:6,fontSize:10,marginTop:4,fontFamily:'inherit',cursor:'pointer'}}>Clear History</button>
    </div>
  )
}

// ── Settings Tab ──────────────────────────────────────
function SettingsTab({brands,activeBrand,onDelete,onUpdate,runs}:any){
  const [sheetsUrl,setSheetsUrl]=useState(()=>LS.get(`sheets_${activeBrand?.id}`,''))
  const [sheetsStatus,setSheetsStatus]=useState('')
  const [syncing,setSyncing]=useState(false)

  async function saveSheets(){LS.set(`sheets_${activeBrand.id}`,sheetsUrl);setSheetsStatus('✓ URL saved')}

  async function testSheets(){
    if(!sheetsUrl){setSheetsStatus('⚠ Enter a URL first');return}
    setSyncing(true);setSheetsStatus('Testing...')
    try{
      const res=await fetch(sheetsUrl,{method:'POST',headers:{'Content-Type':'text/plain'},body:JSON.stringify({orders:[{orderId:'TEST',orderDate:'test',value:'Rs.1',payment:'test',status:'test',location:'test',pincode:'000000'}],mode:'test'})})
      const d=await res.json();setSheetsStatus(d.ok?'✓ Connected!':'⚠ Error: '+JSON.stringify(d))
    }catch(e:any){setSheetsStatus('⚠ '+e.message)}
    setSyncing(false)
  }

  async function syncToSheets(mode:'append'|'replace'){
    if(!sheetsUrl){setSheetsStatus('⚠ Save URL first');return}
    const allOrders=runs.flatMap((r:ScanRun)=>r.orders)
    if(!allOrders.length){setSheetsStatus('⚠ No orders to sync');return}
    setSyncing(true);setSheetsStatus(`Syncing ${allOrders.length} orders...`)
    const BATCH=200;let added=0
    for(let i=0;i<allOrders.length;i+=BATCH){
      const batch=allOrders.slice(i,i+BATCH)
      try{
        const res=await fetch(sheetsUrl,{method:'POST',headers:{'Content-Type':'text/plain'},body:JSON.stringify({orders:batch,mode:i===0?mode:'append'})})
        const d=await res.json();if(d.ok)added+=d.added||0
      }catch(e:any){setSheetsStatus('⚠ Sync error: '+e.message);setSyncing(false);return}
      await new Promise(r=>setTimeout(r,500))
    }
    setSheetsStatus(`✓ Synced ${added} rows to Sheets`)
    setSyncing(false)
  }

  const inp={width:'100%',padding:'8px 10px',fontSize:11,background:'var(--surface)',border:'1px solid var(--border)',color:'var(--text)',borderRadius:6,fontFamily:'inherit',outline:'none'}
  const lbl={fontSize:9,color:'var(--muted)',letterSpacing:'.08em',textTransform:'uppercase' as const,display:'block' as const,marginBottom:4}
  const btn=(extra:any={})=>({background:'var(--surface)',border:'1px solid var(--border)',color:'var(--text)',padding:'8px 12px',borderRadius:6,fontSize:10,fontWeight:700,fontFamily:'inherit',cursor:'pointer',...extra})

  return(
    <div>
      {/* Google Sheets */}
      <div style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:8,padding:14,marginBottom:12}}>
        <div style={{fontSize:10,fontWeight:700,color:'var(--accent)',marginBottom:10,letterSpacing:'.06em',textTransform:'uppercase'}}>Google Sheets Sync</div>
        <div style={{fontSize:9,color:'var(--muted)',marginBottom:10,lineHeight:1.8}}>
          1. Open <a href="https://script.google.com" target="_blank" style={{color:'var(--accent)'}}>Google Apps Script</a><br/>
          2. New project → paste the Apps Script code below → Deploy as web app<br/>
          3. Copy the deployment URL and paste it here
        </div>
        <details style={{marginBottom:10}}>
          <summary style={{fontSize:9,color:'var(--muted)',cursor:'pointer',marginBottom:6}}>Show Apps Script code ▼</summary>
          <pre style={{background:'var(--surface2)',border:'1px solid var(--border)',borderRadius:4,padding:8,fontSize:8,color:'var(--muted)',overflow:'auto',maxHeight:200,lineHeight:1.6}}>{`function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName('Orders') || ss.insertSheet('Orders');
    if (data.mode === 'replace' || sheet.getLastRow() === 0) {
      sheet.clearContents();
      sheet.appendRow(['Order ID','Date','Time','Value','Payment','Status','Location','Pincode']);
    }
    data.orders.forEach(o => {
      sheet.appendRow([o.orderId,o.orderDate,o.orderTime,o.value,o.payment,o.status,o.location,o.pincode]);
    });
    return ContentService.createTextOutput(JSON.stringify({ok:true,added:data.orders.length})).setMimeType(ContentService.MimeType.JSON);
  } catch(e) {
    return ContentService.createTextOutput(JSON.stringify({ok:false,error:e.message})).setMimeType(ContentService.MimeType.JSON);
  }
}`}</pre>
        </details>
        <div style={{marginBottom:8}}>
          <label style={lbl}>Apps Script Webhook URL</label>
          <input value={sheetsUrl} onChange={ev=>setSheetsUrl(ev.target.value)} placeholder="https://script.google.com/macros/s/.../exec" style={inp}/>
        </div>
        {sheetsStatus&&<div style={{fontSize:10,padding:'6px 8px',borderRadius:4,marginBottom:8,background:sheetsStatus.startsWith('✓')?'#00ff8815':'#ff444415',color:sheetsStatus.startsWith('✓')?'var(--accent)':'var(--red)',border:`1px solid ${sheetsStatus.startsWith('✓')?'var(--accent)':'var(--red)'}`}}>{sheetsStatus}</div>}
        <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
          <button onClick={saveSheets} style={btn()}>Save URL</button>
          <button onClick={testSheets} disabled={syncing} style={btn()}>Test Connection</button>
          <button onClick={()=>syncToSheets('append')} disabled={syncing} style={btn({color:'var(--accent)',borderColor:'var(--accent)'})}>↑ Sync (Append)</button>
          <button onClick={()=>syncToSheets('replace')} disabled={syncing} style={btn({color:'var(--warn)',borderColor:'var(--warn)'})}>↺ Sync (Replace)</button>
        </div>
      </div>

      {/* Manage Brands */}
      <div style={{fontSize:9,color:'var(--muted)',textTransform:'uppercase',letterSpacing:'.08em',marginBottom:8}}>Manage Brands</div>
      {brands.map((b:Brand)=>(
        <div key={b.id} style={{background:'var(--surface)',border:`1px solid ${b.id===activeBrand.id?'var(--accent)':'var(--border)'}`,borderRadius:8,padding:12,marginBottom:8}}>
          <div style={{fontWeight:700,color:'var(--accent)',fontSize:12,marginBottom:2}}>{b.name}</div>
          <div style={{fontSize:9,color:'var(--muted)',marginBottom:8,lineHeight:1.8}}>
            {b.subdomain}.shiprocket.co · slug: {b.slug} · ~{b.avgPerDay}/day<br/>anchor: #{b.anchorId} ({b.anchorDate}) · {b.regressionPoints?.length||0} cal pts
          </div>
          <button onClick={()=>onDelete(b.id)} style={{background:'none',border:'1px solid var(--red)',color:'var(--red)',padding:'5px 12px',borderRadius:4,fontSize:9,fontWeight:700,fontFamily:'inherit',cursor:'pointer'}}>Delete Brand</button>
        </div>
      ))}
      <div style={{marginTop:12,padding:12,background:'var(--surface)',border:'1px solid var(--border)',borderRadius:8,fontSize:9,color:'var(--muted)',lineHeight:2}}>
        <div style={{color:'var(--accent)',fontWeight:700,marginBottom:4,fontSize:10}}>About</div>
        Data in browser localStorage · Scraping via Vercel Edge (server-side IPs)<br/>
        Free forever · by RahulJ
      </div>
    </div>
  )
}
