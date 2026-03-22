'use client'

import { useState, useEffect, useRef, useCallback } from 'react'

// ── Types ──────────────────────────────────────────────
interface Brand {
  id: string
  name: string
  subdomain: string
  slug: string
  companyName: string
  anchorId: number
  anchorDate: string
  avgPerDay: number
  regressionPoints: Array<{date: string, id: number}>
}

interface Order {
  orderId: number; slug: string; orderDate: string; orderTime: string
  dateYMD: string | null; value: string; valueNum: number
  payment: string; status: string; pincode: string; location: string
}

interface ScanRun {
  runId: string; dateRange: string; found: number; scanned: number
  orders: Order[]; createdAt: string
}

interface Analytics {
  totalOrders: number; totalRevenue: number; avgOrderVal: number
  codCount: number; prepaidCount: number; codPct: number
  topCities: Array<{city: string, count: number}>
  daily: Array<{date: string, orders: number, revenue: number, cod: number, prepaid: number}>
  hours: Array<{hour: string, count: number}>
  valueBuckets: Record<string, number>
  velocity: string
}

// ── Local storage helpers ──────────────────────────────
const LS = {
  get: <T,>(k: string, def: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def } catch { return def } },
  set: (k: string, v: any) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} },
}

// ── Analytics builder ──────────────────────────────────
function buildAnalytics(orders: Order[]): Analytics | null {
  if (!orders.length) return null
  const N = orders.length
  const rev = orders.reduce((s, r) => s + (r.valueNum || 0), 0)
  const cod = orders.filter(r => (r.payment || '').toUpperCase() === 'COD')
  const RTO = new Set(['HUB','ETAIL','E-TAIL','SORTING','GATEWAY','DEPOT','FACILITY','WAREHOUSE','PROCESSING'])
  const isRTO = (city: string) => {
    const c = city.toUpperCase().trim()
    return !c || c === 'N/A' || c.split(/[\s,\-]+/).some(w => RTO.has(w))
  }
  const cityMap: Record<string, number> = {}
  const dayMap: Record<string, {orders:number,revenue:number,cod:number,prepaid:number}> = {}
  const hourMap: Record<string, number> = {}
  const valMap: Record<string, number> = {'0-500':0,'500-1k':0,'1k-1.5k':0,'1.5k-2k':0,'2k+':0}

  orders.forEach(r => {
    const c = (r.location || 'N/A').trim()
    if (!isRTO(c)) cityMap[c] = (cityMap[c] || 0) + 1
    if (r.dateYMD) {
      if (!dayMap[r.dateYMD]) dayMap[r.dateYMD] = {orders:0,revenue:0,cod:0,prepaid:0}
      dayMap[r.dateYMD].orders++
      dayMap[r.dateYMD].revenue += r.valueNum || 0
      ;(r.payment||'').toUpperCase()==='COD' ? dayMap[r.dateYMD].cod++ : dayMap[r.dateYMD].prepaid++
    }
    if (r.orderTime && r.orderTime !== 'N/A') { const h = r.orderTime.slice(0,2)+'h'; hourMap[h]=(hourMap[h]||0)+1 }
    const v = r.valueNum || 0
    if (v<500) valMap['0-500']++; else if (v<1000) valMap['500-1k']++
    else if (v<1500) valMap['1k-1.5k']++; else if (v<2000) valMap['1.5k-2k']++; else valMap['2k+']++
  })

  const topCities = Object.entries(cityMap).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([city,count])=>({city,count}))
  const daily = Object.keys(dayMap).sort().map(k=>({date:k,...dayMap[k]}))
  const hours = Object.entries(hourMap).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([h,c])=>({hour:h,count:c}))
  let velocity = 'stable'
  if (daily.length>=6) {
    const rec=daily.slice(-3).reduce((s,d)=>s+d.orders,0)/3
    const old=daily.slice(0,3).reduce((s,d)=>s+d.orders,0)/3
    if(rec>old*1.15)velocity='growing'; else if(rec<old*0.85)velocity='shrinking'
  }
  return { totalOrders:N, totalRevenue:rev, avgOrderVal:rev/N, codCount:cod.length, prepaidCount:N-cod.length,
           codPct:Math.round((cod.length/N)*100), topCities, daily, hours, valueBuckets:valMap, velocity }
}

// ── CSV builders ───────────────────────────────────────
function buildCSV(orders: Order[]): string {
  const e = (v: any) => `"${String(v??'').replace(/"/g,'""')}"`
  let s = 'Order ID,Date,Time,Value,Payment,Status,Location,Pincode\n'
  const sorted = [...orders].sort((a,b)=>(a.dateYMD||'').localeCompare(b.dateYMD||'')||(a.orderTime||'').localeCompare(b.orderTime||''))
  sorted.forEach(r => s += `${e(r.orderId)},${e(r.orderDate)},${e(r.orderTime)},${e(r.value)},${e(r.payment)},${e(r.status)},${e(r.location)},${e(r.pincode)}\n`)
  return s
}

function buildReport(orders: Order[], brandName: string, dateRange: string): string {
  const a = buildAnalytics(orders); if (!a) return ''
  const e = (v: any) => `"${String(v??'').replace(/"/g,'""')}"`
  const f = (n: number) => 'Rs.'+Number(n||0).toFixed(2)
  const fd = (ymd: string) => { const[y,m,d]=ymd.split('-'); return new Date(+y,+m-1,+d).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'}) }
  let s = `BRAND INTELLIGENCE REPORT\nBrand,${e(brandName)}\nDate Range,${e(dateRange)}\nGenerated,${new Date().toLocaleString('en-IN')}\n\n`
  s += `SUMMARY\nTotal Orders,${a.totalOrders}\nRevenue,${f(a.totalRevenue)}\nAvg Value,${f(a.avgOrderVal)}\nCOD,${a.codCount} (${a.codPct}%)\nPrepaid,${a.prepaidCount}\nVelocity,${a.velocity}\n\n`
  s += 'TOP CITIES\nCity,Orders\n'; a.topCities.forEach(c=>s+=`${e(c.city)},${c.count}\n`)
  s += '\nPEAK HOURS\nHour,Orders\n'; a.hours.forEach(h=>s+=`${e(h.hour)},${h.count}\n`)
  s += '\nVALUE DISTRIBUTION\nBucket,Orders\n'; Object.entries(a.valueBuckets).forEach(([k,v])=>s+=`${e('Rs.'+k)},${v}\n`)
  s += '\nDAILY BREAKDOWN\nDate,Orders,Revenue,COD,Prepaid\n'
  a.daily.forEach(d=>s+=`${e(fd(d.date))},${d.orders},${f(d.revenue)},${d.cod},${d.prepaid}\n`)
  s += '\nORDERS\nOrder ID,Date,Time,Value,Payment,Status,Location,Pincode\n'
  const sorted=[...orders].sort((a,b)=>(a.dateYMD||'').localeCompare(b.dateYMD||''))
  sorted.forEach(r=>s+=`${e(r.orderId)},${e(r.orderDate)},${e(r.orderTime)},${e(r.value)},${e(r.payment)},${e(r.status)},${e(r.location)},${e(r.pincode)}\n`)
  return s
}

function download(content: string, filename: string) {
  const a = document.createElement('a')
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(content)
  a.download = filename; a.click()
}

const fmtRs = (n: number) => 'Rs.' + Math.round(n).toLocaleString('en-IN')

// ═══════════════════════════════════════════════════════
//  MAIN APP
// ═══════════════════════════════════════════════════════
export default function App() {
  const [brands, setBrands] = useState<Brand[]>([])
  const [activeBrand, setActiveBrand] = useState<Brand | null>(null)
  const [tab, setTab] = useState<'date'|'manual'|'analytics'|'history'|'settings'>('date')
  const [runs, setRuns] = useState<ScanRun[]>([])
  const [lastOrders, setLastOrders] = useState<Order[]>([])
  const [analytics, setAnalytics] = useState<Analytics | null>(null)
  const [isScanning, setIsScanning] = useState(false)
  const [scanLog, setScanLog] = useState<Array<{msg:string,cls:string}>>([{msg:'Select a date range and click Find & Scrape.',cls:''}])
  const [progress, setProgress] = useState({ done: 0, total: 0, found: 0 })
  const [startedAt, setStartedAt] = useState(0)
  const [showAddBrand, setShowAddBrand] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const logRef = useRef<HTMLDivElement>(null)

  // Load from localStorage on mount
  useEffect(() => {
    const saved = LS.get<Brand[]>('brands', [])
    setBrands(saved)
    const activeId = LS.get<string>('activeBrandId', '')
    if (activeId) { const b = saved.find(x=>x.id===activeId); if(b)setActiveBrand(b) }
    else if (saved.length) { setActiveBrand(saved[0]); LS.set('activeBrandId', saved[0].id) }
  }, [])

  useEffect(() => {
    if (activeBrand) {
      const savedRuns = LS.get<ScanRun[]>(`runs_${activeBrand.id}`, [])
      setRuns(savedRuns)
      if (savedRuns.length > 0) {
        const last = savedRuns[0]
        setLastOrders(last.orders)
        setAnalytics(buildAnalytics(last.orders))
      } else {
        setLastOrders([]); setAnalytics(null)
      }
    }
  }, [activeBrand?.id])

  // Auto-scroll log
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [scanLog])

  const addLog = useCallback((msg: string, cls: string = '') => {
    setScanLog(prev => [...prev.slice(-300), { msg, cls }])
  }, [])

  // ── Brand management ──
  function selectBrand(b: Brand) {
    setActiveBrand(b); LS.set('activeBrandId', b.id)
    const savedRuns = LS.get<ScanRun[]>(`runs_${b.id}`, [])
    setRuns(savedRuns)
    if (savedRuns.length > 0) { setLastOrders(savedRuns[0].orders); setAnalytics(buildAnalytics(savedRuns[0].orders)) }
    else { setLastOrders([]); setAnalytics(null) }
  }

  function deleteBrand(id: string) {
    if (!confirm('Delete this brand and all its data?')) return
    const updated = brands.filter(b=>b.id!==id)
    setBrands(updated); LS.set('brands', updated)
    localStorage.removeItem(`runs_${id}`)
    if (activeBrand?.id === id) { setActiveBrand(updated[0]||null); LS.set('activeBrandId', updated[0]?.id||'') }
  }

  // ── Scan ──────────────────────────────────────────────
  async function startScan(fromDate: string, toDate: string, concurrency: number) {
    if (!activeBrand || isScanning) return
    setIsScanning(true)
    setScanLog([])
    setProgress({ done: 0, total: 0, found: 0 })
    setStartedAt(Date.now())
    const ab = new AbortController(); abortRef.current = ab
    const orders: Order[] = []

    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          brandId: activeBrand.id,
          subdomain: activeBrand.subdomain,
          slug: activeBrand.slug,
          anchorId: activeBrand.anchorId,
          anchorDate: activeBrand.anchorDate,
          avgPerDay: activeBrand.avgPerDay,
          regressionPoints: activeBrand.regressionPoints,
          fromDate, toDate, concurrency
        }),
        signal: ab.signal
      })

      if (!res.ok || !res.body) throw new Error('Scan failed')

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const data = JSON.parse(line.slice(6))
            if (data.type === 'log') addLog(data.msg, data.cls || '')
            else if (data.type === 'order') orders.push(data.order)
            else if (data.type === 'progress') setProgress({ done: data.done, total: data.total, found: data.found })
            else if (data.type === 'start') setProgress(p => ({ ...p, total: data.total }))
            else if (data.type === 'error') addLog('⚠ ' + data.msg, 'err')
            else if (data.type === 'done') {
              // Save run
              const dates = orders.map(r=>r.dateYMD).filter(Boolean).sort()
              const dateLabel = dates.length===0 ? `${fromDate} to ${toDate}`
                              : dates[0]===dates[dates.length-1] ? dates[0]!
                              : `${dates[0]} to ${dates[dates.length-1]}`
              const run: ScanRun = {
                runId: data.runId || Date.now().toString(),
                dateRange: dateLabel,
                found: data.matched || orders.length,
                scanned: data.scanned || 0,
                orders,
                createdAt: new Date().toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'})
              }
              const updated = [run, ...LS.get<ScanRun[]>(`runs_${activeBrand.id}`, [])].slice(0, 50)
              LS.set(`runs_${activeBrand.id}`, updated)
              setRuns(updated)
              setLastOrders(orders)
              setAnalytics(buildAnalytics(orders))

              // Update regression points
              const byDate: Record<string, {min:number,max:number}> = {}
              orders.forEach(o => {
                if (!o.dateYMD) return
                if (!byDate[o.dateYMD]) byDate[o.dateYMD] = {min:o.orderId,max:o.orderId}
                else { byDate[o.dateYMD].min=Math.min(byDate[o.dateYMD].min,o.orderId); byDate[o.dateYMD].max=Math.max(byDate[o.dateYMD].max,o.orderId) }
              })
              const newPts = Object.entries(byDate).map(([date,{min,max}])=>({date,id:Math.round((min+max)/2)}))
              const existing = activeBrand.regressionPoints || []
              const merged = Object.values(Object.fromEntries([...existing,...newPts].map(p=>[p.date,p])))
              merged.sort((a,b)=>a.date.localeCompare(b.date))
              const regPts = merged.slice(-30)
              let newAvg = activeBrand.avgPerDay
              if (merged.length>=2) {
                const f=merged[0],l=merged[merged.length-1]
                const days=(new Date(l.date+' 00:00:00').getTime()-new Date(f.date+' 00:00:00').getTime())/86400000
                if(days>0) newAvg=Math.min(500,Math.max(1,Math.ceil((l.id-f.id)/days)))
              }
              const updated2 = {...activeBrand, regressionPoints:regPts, avgPerDay:newAvg}
              setActiveBrand(updated2)
              const allBrands = brands.map(b=>b.id===activeBrand.id?updated2:b)
              setBrands(allBrands); LS.set('brands', allBrands)
              addLog(`✓ Done: ${dateLabel} — ${orders.length} orders`, 'ok')
            }
          } catch {}
        }
      }
    } catch (e: any) {
      if (e.name !== 'AbortError') addLog('Error: ' + e.message, 'err')
    } finally {
      setIsScanning(false)
    }
  }

  function stopScan() {
    abortRef.current?.abort()
    setIsScanning(false)
    addLog('Scan stopped.', 'info')
  }

  const eta = (() => {
    if (!startedAt || !progress.done || !progress.total) return ''
    const elapsed = (Date.now() - startedAt) / 1000
    const rate = progress.done / elapsed
    const rem = rate > 0 ? (progress.total - progress.done) / rate : 0
    if (rem >= 3600) return `${Math.floor(rem/3600)}h ${Math.floor((rem%3600)/60)}m`
    if (rem >= 60) return `${Math.floor(rem/60)}m ${Math.floor(rem%60)}s`
    return `${Math.floor(rem)}s`
  })()

  // ── Render ─────────────────────────────────────────────
  return (
    <div style={{maxWidth:900,margin:'0 auto',padding:'20px 16px',minHeight:'100vh'}}>

      {/* Header */}
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:20}}>
        <div>
          <h1 style={{fontSize:14,fontWeight:700,letterSpacing:'0.1em',color:'var(--accent)',textTransform:'uppercase'}}>
            Shiprocket Order Scrapper
          </h1>
          <div style={{fontSize:10,color:'var(--muted)',marginTop:2}}>by RahulJ · PRO v5.0 · Free Web Edition</div>
        </div>
        <button onClick={()=>setShowAddBrand(true)} style={{background:'var(--accent)',color:'#000',border:'none',padding:'7px 14px',borderRadius:6,fontSize:11,fontWeight:700,letterSpacing:'0.06em'}}>
          + ADD BRAND
        </button>
      </div>

      {/* Brand selector */}
      {brands.length > 0 && (
        <div style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:8,padding:'8px 12px',marginBottom:12,display:'flex',alignItems:'center',gap:10}}>
          <span style={{fontSize:9,color:'var(--muted)',letterSpacing:'0.08em',textTransform:'uppercase',flexShrink:0}}>Brand</span>
          <select value={activeBrand?.id||''} onChange={e=>{const b=brands.find(x=>x.id===e.target.value);if(b)selectBrand(b)}}
            style={{flex:1,border:'none',background:'transparent',fontSize:13,fontWeight:700,padding:'2px 0'}}>
            {brands.map(b=><option key={b.id} value={b.id}>{b.name} ({b.subdomain}.shiprocket.co)</option>)}
          </select>
          <span style={{fontSize:9,color:'var(--muted)'}}>{activeBrand ? `~${activeBrand.avgPerDay}/day · ${activeBrand.regressionPoints?.length||0} cal pts` : ''}</span>
        </div>
      )}

      {/* No brand */}
      {brands.length === 0 && !showAddBrand && (
        <div style={{textAlign:'center',padding:'60px 20px',color:'var(--muted)'}}>
          <div style={{fontSize:32,marginBottom:16}}>📦</div>
          <div style={{fontSize:13,marginBottom:8}}>No brands added yet</div>
          <div style={{fontSize:11,lineHeight:2}}>Click <span style={{color:'var(--accent)'}}>+ ADD BRAND</span> to get started<br/>You need: subdomain · one known order ID · its date</div>
        </div>
      )}

      {/* Add Brand Modal */}
      {showAddBrand && <AddBrandForm brands={brands} onAdd={brand=>{
        const updated=[...brands,brand]; setBrands(updated); LS.set('brands',updated)
        selectBrand(brand); setShowAddBrand(false)
      }} onCancel={()=>setShowAddBrand(false)}/>}

      {/* Main UI */}
      {activeBrand && !showAddBrand && (
        <>
          {/* Dashboard strip */}
          <DashboardStrip runs={runs}/>

          {/* Tabs */}
          <div style={{display:'flex',borderBottom:'1px solid var(--border)',marginBottom:16,gap:0,overflowX:'auto'}}>
            {(['date','manual','analytics','history','settings'] as const).map(t=>(
              <button key={t} onClick={()=>setTab(t)} style={{
                background:'none',border:'none',borderBottom:`2px solid ${tab===t?'var(--accent)':'transparent'}`,
                color:tab===t?'var(--accent)':'var(--muted)',fontSize:10,fontWeight:700,letterSpacing:'0.08em',
                textTransform:'uppercase',padding:'8px 14px',cursor:'pointer',marginBottom:-1,whiteSpace:'nowrap'
              }}>{t==='date'?'By Date':t}</button>
            ))}
          </div>

          {/* BY DATE */}
          {tab==='date' && (
            <DateTab activeBrand={activeBrand} isScanning={isScanning}
              scanLog={scanLog} progress={progress} eta={eta} logRef={logRef}
              lastOrders={lastOrders}
              onStart={startScan} onStop={stopScan}/>
          )}

          {/* MANUAL */}
          {tab==='manual' && <ManualTab activeBrand={activeBrand}/>}

          {/* ANALYTICS */}
          {tab==='analytics' && <AnalyticsTab analytics={analytics} />}

          {/* HISTORY */}
          {tab==='history' && (
            <HistoryTab runs={runs} brandName={activeBrand.name}
              onClear={()=>{localStorage.removeItem(`runs_${activeBrand.id}`);setRuns([]);setLastOrders([]);setAnalytics(null)}}/>
          )}

          {/* SETTINGS */}
          {tab==='settings' && (
            <SettingsTab brands={brands} activeBrand={activeBrand}
              onDelete={deleteBrand}
              onUpdate={(updated: Brand)=>{
                const all=brands.map(b=>b.id===updated.id?updated:b)
                setBrands(all); LS.set('brands',all); setActiveBrand(updated)
              }}/>
          )}
        </>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════
//  ADD BRAND FORM
// ═══════════════════════════════════════════════════════
function AddBrandForm({ brands, onAdd, onCancel }: { brands: Brand[], onAdd: (b:Brand)=>void, onCancel:()=>void }) {
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [subdomain, setSubdomain] = useState('')
  const [orderId, setOrderId] = useState('')
  const [anchorDate, setAnchorDate] = useState('')
  const [status, setStatus] = useState<{msg:string,ok:boolean}|null>(null)
  const [loading, setLoading] = useState(false)

  function handleUrl(v: string) {
    setUrl(v)
    const m = v.match(/https?:\/\/([^.]+)\.shiprocket\.co/)
    if (m) { setSubdomain(m[1]); if (!name) setName(m[1].charAt(0).toUpperCase()+m[1].slice(1)) }
  }

  async function verify() {
    if (!subdomain || !orderId) { setStatus({msg:'Enter subdomain and order ID',ok:false}); return }
    setLoading(true); setStatus(null)
    const r = await fetch('/api/detect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subdomain,orderId})})
    const d = await r.json(); setLoading(false)
    if (d.ok) setStatus({msg:`✓ Slug: ${d.slug} | ${d.companyName}`,ok:true})
    else setStatus({msg:d.error||'Failed',ok:false})
  }

  async function add() {
    if (!name||!subdomain||!orderId||!anchorDate) { setStatus({msg:'Fill all fields',ok:false}); return }
    setLoading(true)
    const detect = await fetch('/api/detect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subdomain,orderId})})
    const d = await detect.json()
    if (!d.ok) { setStatus({msg:d.error||'Cannot detect slug',ok:false}); setLoading(false); return }
    const est = await fetch('/api/estimate-avg',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subdomain,anchorId:parseInt(orderId),slug:d.slug})})
    const e = await est.json()
    const brand: Brand = {
      id: Date.now().toString(), name, subdomain, slug:d.slug, companyName:d.companyName,
      anchorId:parseInt(orderId), anchorDate, avgPerDay:e.avgPerDay||30, regressionPoints:[]
    }
    setLoading(false); onAdd(brand)
  }

  return (
    <div style={{background:'var(--surface)',border:'1px solid var(--accent)',borderRadius:10,padding:20,marginBottom:16}}>
      <div style={{fontSize:11,fontWeight:700,color:'var(--accent)',letterSpacing:'0.08em',textTransform:'uppercase',marginBottom:14}}>+ Add New Brand</div>
      <div style={{display:'grid',gap:10}}>
        <div>
          <label style={{fontSize:9,color:'var(--muted)',letterSpacing:'0.08em',textTransform:'uppercase',display:'block',marginBottom:4}}>Shiprocket URL (auto-fills below)</label>
          <input value={url} onChange={e=>handleUrl(e.target.value)} placeholder="https://everlasting.shiprocket.co/" style={{width:'100%',padding:'8px 10px',fontSize:12}}/>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
          <div>
            <label style={{fontSize:9,color:'var(--muted)',letterSpacing:'0.08em',textTransform:'uppercase',display:'block',marginBottom:4}}>Brand Name</label>
            <input value={name} onChange={e=>setName(e.target.value)} placeholder="e.g. Everlasting" style={{width:'100%',padding:'8px 10px',fontSize:12}}/>
          </div>
          <div>
            <label style={{fontSize:9,color:'var(--muted)',letterSpacing:'0.08em',textTransform:'uppercase',display:'block',marginBottom:4}}>Subdomain</label>
            <input value={subdomain} onChange={e=>setSubdomain(e.target.value)} placeholder="e.g. everlasting" style={{width:'100%',padding:'8px 10px',fontSize:12}}/>
          </div>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
          <div>
            <label style={{fontSize:9,color:'var(--muted)',letterSpacing:'0.08em',textTransform:'uppercase',display:'block',marginBottom:4}}>One Known Order ID</label>
            <input type="number" value={orderId} onChange={e=>setOrderId(e.target.value)} placeholder="e.g. 437470" style={{width:'100%',padding:'8px 10px',fontSize:12}}/>
          </div>
          <div>
            <label style={{fontSize:9,color:'var(--muted)',letterSpacing:'0.08em',textTransform:'uppercase',display:'block',marginBottom:4}}>That Order's Date</label>
            <input type="date" value={anchorDate} onChange={e=>setAnchorDate(e.target.value)} style={{width:'100%',padding:'8px 10px',fontSize:12}}/>
          </div>
        </div>
        {status && <div style={{padding:'8px 10px',borderRadius:6,fontSize:11,background:status.ok?'#00ff8815':'#ff444415',border:`1px solid ${status.ok?'var(--accent)':'var(--red)'}`,color:status.ok?'var(--accent)':'var(--red)'}}>{status.msg}</div>}
        <div style={{display:'flex',gap:8}}>
          <button onClick={verify} disabled={loading} style={{flex:1,padding:'9px',borderRadius:6,background:'var(--surface2)',border:'1px solid var(--border)',color:'var(--text)',fontSize:11,fontWeight:700}}>
            {loading?'...':'🔍 Verify'}
          </button>
          <button onClick={add} disabled={loading} style={{flex:2,padding:'9px',borderRadius:6,background:'var(--accent)',border:'none',color:'#000',fontSize:11,fontWeight:700}}>
            {loading?'Adding...':'✓ Add Brand'}
          </button>
          <button onClick={onCancel} style={{flex:1,padding:'9px',borderRadius:6,background:'none',border:'1px solid var(--border)',color:'var(--muted)',fontSize:11}}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════
//  DASHBOARD STRIP
// ═══════════════════════════════════════════════════════
function DashboardStrip({ runs }: { runs: ScanRun[] }) {
  const allOrders = runs.flatMap(r=>r.orders)
  const today = new Date(); const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`
  const yest  = new Date(today); yest.setDate(yest.getDate()-1)
  const yestStr = `${yest.getFullYear()}-${String(yest.getMonth()+1).padStart(2,'0')}-${String(yest.getDate()).padStart(2,'0')}`
  const prefix  = todayStr.slice(0,7)
  const todayOrders = allOrders.filter(o=>o.dateYMD===todayStr)
  const yestOrders  = allOrders.filter(o=>o.dateYMD===yestStr)
  const mtdOrders   = allOrders.filter(o=>o.dateYMD?.startsWith(prefix))
  const totalTracked = allOrders.length

  const card = (label: string, val: string, sub: string) => (
    <div style={{flex:1,background:'var(--surface)',border:'1px solid var(--border)',borderRadius:8,padding:'10px 12px',minWidth:0}}>
      <div style={{fontSize:8,color:'var(--muted)',textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:4}}>{label}</div>
      <div style={{fontSize:15,fontWeight:700,color:'var(--accent)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{val}</div>
      <div style={{fontSize:9,color:'var(--muted)',marginTop:2,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{sub}</div>
    </div>
  )

  return (
    <div style={{display:'flex',gap:6,marginBottom:14,overflow:'auto'}}>
      {card('Yesterday', yestOrders.length?String(yestOrders.length):'--', yestOrders.length?`${fmtRs(yestOrders.reduce((s,o)=>s+o.valueNum,0))} | COD ${yestOrders.filter(o=>o.payment.toUpperCase()==='COD').length}`:'Not scraped yet')}
      {card('Today', todayOrders.length?String(todayOrders.length):'--', todayOrders.length?`${fmtRs(todayOrders.reduce((s,o)=>s+o.valueNum,0))} | COD ${todayOrders.filter(o=>o.payment.toUpperCase()==='COD').length}`:'Not scraped')}
      {card('MTD Orders', mtdOrders.length?String(mtdOrders.length):'--', mtdOrders.length?`${new Date().toLocaleString('en-IN',{month:'short',year:'numeric'})} · ${fmtRs(mtdOrders.reduce((s,o)=>s+o.valueNum,0)/Math.max(mtdOrders.length,1))} avg`:'--')}
      {card('Tracked', String(totalTracked), `${runs.length} scan runs`)}
    </div>
  )
}

// ═══════════════════════════════════════════════════════
//  DATE TAB
// ═══════════════════════════════════════════════════════
function DateTab({ activeBrand, isScanning, scanLog, progress, eta, logRef, lastOrders, onStart, onStop }: any) {
  const today = new Date()
  const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`
  const yest = new Date(today); yest.setDate(yest.getDate()-1)
  const yestStr = `${yest.getFullYear()}-${String(yest.getMonth()+1).padStart(2,'0')}-${String(yest.getDate()).padStart(2,'0')}`
  const [from, setFrom] = useState(yestStr)
  const [to, setTo] = useState(todayStr)
  const [conc, setConc] = useState('5')
  const pct = progress.total ? Math.min(progress.done/progress.total*100,100) : 0

  return (
    <div>
      {/* Anchor info */}
      <div style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:6,padding:'8px 12px',marginBottom:12,fontSize:9,color:'var(--muted)',lineHeight:1.8}}>
        Anchor: <span style={{color:'var(--accent)'}}>#{activeBrand.anchorId} = {activeBrand.anchorDate}</span>
        {' · '}slug: <span style={{color:'var(--accent)'}}>{activeBrand.slug}</span>
        {' · '}~{activeBrand.avgPerDay}/day
        {' · '}{activeBrand.regressionPoints?.length||0} cal pts
      </div>

      {/* Date pickers */}
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:10}}>
        <div>
          <label style={{fontSize:9,color:'var(--muted)',letterSpacing:'0.08em',textTransform:'uppercase',display:'block',marginBottom:4}}>From</label>
          <input type="date" value={from} onChange={e=>setFrom(e.target.value)} style={{width:'100%',padding:'8px 10px',fontSize:13}}/>
        </div>
        <div>
          <label style={{fontSize:9,color:'var(--muted)',letterSpacing:'0.08em',textTransform:'uppercase',display:'block',marginBottom:4}}>To</label>
          <input type="date" value={to} onChange={e=>setTo(e.target.value)} style={{width:'100%',padding:'8px 10px',fontSize:13}}/>
        </div>
      </div>

      {/* Concurrency */}
      <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:12,fontSize:11,color:'var(--muted)'}}>
        <span>Concurrent fetches</span>
        <select value={conc} onChange={e=>setConc(e.target.value)} style={{padding:'4px 8px',fontSize:11}}>
          {['3','5','8','10','15'].map(v=><option key={v} value={v}>{v}</option>)}
        </select>
        <span style={{fontSize:9}}>(higher = faster, more rate limit risk)</span>
      </div>

      {/* Scan button */}
      {!isScanning ? (
        <button onClick={()=>onStart(from,to,parseInt(conc))}
          style={{width:'100%',background:'var(--accent)',color:'#000',border:'none',padding:11,borderRadius:8,fontSize:12,fontWeight:700,letterSpacing:'0.06em',textTransform:'uppercase',marginBottom:12}}>
          🔍 FIND &amp; SCRAPE
        </button>
      ) : (
        <div style={{display:'flex',gap:8,marginBottom:12}}>
          <button onClick={onStop} style={{flex:1,background:'var(--surface)',color:'var(--red)',border:'1px solid var(--red)',padding:10,borderRadius:8,fontSize:11,fontWeight:700}}>■ STOP</button>
        </div>
      )}

      {/* Progress */}
      {isScanning && (
        <div style={{marginBottom:12}}>
          <div style={{display:'flex',justifyContent:'space-between',fontSize:10,color:'var(--muted)',marginBottom:6}}>
            <span>{progress.done} / {progress.total || '?'} — {progress.found} found</span>
            <span style={{color:'var(--accent)'}}>{eta ? `ETA: ${eta}` : 'Calculating...'}</span>
          </div>
          <div style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:4,height:6,overflow:'hidden'}}>
            <div style={{height:'100%',background:'var(--accent)',width:`${pct}%`,transition:'width 0.3s',borderRadius:4}}/>
          </div>
        </div>
      )}

      {/* Log */}
      <div ref={logRef} style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:6,padding:10,minHeight:80,maxHeight:200,overflowY:'auto',fontFamily:'inherit',fontSize:10,lineHeight:1.8,marginBottom:12}}>
        {scanLog.map((l,i)=>(
          <div key={i} style={{color:l.cls==='ok'?'var(--accent)':l.cls==='err'?'var(--red)':l.cls==='info'?'var(--warn)':'var(--muted)'}}>{l.msg}</div>
        ))}
      </div>

      {/* Export */}
      {lastOrders.length > 0 && !isScanning && (
        <div style={{display:'flex',gap:8}}>
          <button onClick={()=>download(buildCSV(lastOrders),`${activeBrand.name}_${from}_to_${to}.csv`)}
            style={{flex:1,background:'var(--surface)',border:'1px solid var(--border)',color:'var(--text)',padding:9,borderRadius:6,fontSize:11,fontWeight:700}}>↓ CSV ({lastOrders.length})</button>
          <button onClick={()=>download(buildReport(lastOrders,activeBrand.name,`${from} to ${to}`),`${activeBrand.name}_report.csv`)}
            style={{flex:1,background:'var(--surface)',border:'1px solid var(--border)',color:'var(--text)',padding:9,borderRadius:6,fontSize:11,fontWeight:700}}>↓ Full Report</button>
          <button onClick={()=>{
            const a=buildAnalytics(lastOrders);if(!a)return
            const top=a.topCities[0]
            const txt=`📦 *${activeBrand.name}*\nOrders: *${a.totalOrders}* | Revenue: *${fmtRs(a.totalRevenue)}*\nCOD: ${a.codCount} (${a.codPct}%) | Avg: ${fmtRs(a.avgOrderVal)}\n`+(top?`🏆 ${top.city} (${top.count})\n`:'')+`📈 ${a.velocity}`
            navigator.clipboard.writeText(txt)
          }} style={{flex:1,background:'var(--surface)',border:'1px solid #25d366',color:'#25d366',padding:9,borderRadius:6,fontSize:11,fontWeight:700}}>📱 WA</button>
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════
//  MANUAL TAB (simplified)
// ═══════════════════════════════════════════════════════
function ManualTab({ activeBrand }: { activeBrand: Brand }) {
  return (
    <div style={{textAlign:'center',padding:'40px 20px',color:'var(--muted)'}}>
      <div style={{fontSize:12,marginBottom:8}}>Manual scrape coming soon</div>
      <div style={{fontSize:10}}>Use By Date tab for now — it handles all use cases</div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════
//  ANALYTICS TAB
// ═══════════════════════════════════════════════════════
function AnalyticsTab({ analytics }: { analytics: Analytics | null }) {
  if (!analytics) return (
    <div style={{textAlign:'center',padding:'40px 20px',color:'var(--muted)',fontSize:11}}>Run a scan first to see analytics.</div>
  )
  const a = analytics
  return (
    <div style={{display:'grid',gap:12}}>
      {/* Summary cards */}
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
        {[
          ['Total Orders', String(a.totalOrders),''],
          ['Total Revenue', fmtRs(a.totalRevenue),''],
          ['Avg Order Value', fmtRs(a.avgOrderVal), `Trend: ${a.velocity}`],
          ['COD vs Prepaid', `${a.codCount} / ${a.prepaidCount}`, `${a.codPct}% COD`],
        ].map(([label,val,sub])=>(
          <div key={label} style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:8,padding:'10px 12px'}}>
            <div style={{fontSize:8,color:'var(--muted)',textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:4}}>{label}</div>
            <div style={{fontSize:16,fontWeight:700,color:'var(--accent)'}}>{val}</div>
            {sub&&<div style={{fontSize:9,color:'var(--muted)',marginTop:2}}>{sub}</div>}
          </div>
        ))}
      </div>

      {/* Top Cities */}
      <Section title="Top Cities (excl. courier hubs)">
        {a.topCities.slice(0,8).map(c=>(
          <Row key={c.city} label={c.city} value={String(c.count)}/>
        ))}
      </Section>

      {/* Peak Hours */}
      <Section title="Peak Order Hours">
        <div style={{display:'flex',flexWrap:'wrap',gap:6}}>
          {a.hours.map(h=>(
            <div key={h.hour} style={{background:'var(--surface2)',border:'1px solid var(--border)',borderRadius:4,padding:'4px 8px',fontSize:10}}>
              <span style={{color:'var(--accent)',fontWeight:700}}>{h.hour}</span>
              <span style={{color:'var(--muted)',marginLeft:4}}>{h.count}</span>
            </div>
          ))}
        </div>
      </Section>

      {/* Value buckets */}
      <Section title="Order Value Distribution">
        {Object.entries(a.valueBuckets).map(([k,v])=>(
          <Row key={k} label={`Rs.${k}`} value={String(v)}/>
        ))}
      </Section>

      {/* Daily trend */}
      <Section title="Daily Breakdown">
        <div style={{overflowX:'auto'}}>
          <table style={{width:'100%',fontSize:10,borderCollapse:'collapse'}}>
            <thead><tr style={{color:'var(--muted)'}}>
              <th style={{textAlign:'left',padding:'4px 8px',borderBottom:'1px solid var(--border)'}}>Date</th>
              <th style={{textAlign:'right',padding:'4px 8px',borderBottom:'1px solid var(--border)'}}>Orders</th>
              <th style={{textAlign:'right',padding:'4px 8px',borderBottom:'1px solid var(--border)'}}>Revenue</th>
              <th style={{textAlign:'right',padding:'4px 8px',borderBottom:'1px solid var(--border)'}}>COD</th>
            </tr></thead>
            <tbody>
              {a.daily.map(d=>(
                <tr key={d.date} style={{borderBottom:'1px solid var(--border)'}}>
                  <td style={{padding:'4px 8px',color:'var(--text)'}}>{d.date}</td>
                  <td style={{padding:'4px 8px',color:'var(--accent)',textAlign:'right',fontWeight:700}}>{d.orders}</td>
                  <td style={{padding:'4px 8px',color:'var(--muted)',textAlign:'right'}}>{fmtRs(d.revenue)}</td>
                  <td style={{padding:'4px 8px',color:'var(--muted)',textAlign:'right'}}>{d.cod}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  )
}

function Section({ title, children }: { title: string, children: React.ReactNode }) {
  return (
    <div style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:8,padding:'10px 12px'}}>
      <div style={{fontSize:8,color:'var(--muted)',textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:8}}>{title}</div>
      {children}
    </div>
  )
}
function Row({ label, value }: { label: string, value: string }) {
  return (
    <div style={{display:'flex',justifyContent:'space-between',fontSize:11,padding:'3px 0',borderBottom:'1px solid var(--border)'}}>
      <span style={{color:'var(--text)'}}>{label}</span>
      <span style={{color:'var(--accent)',fontWeight:700}}>{value}</span>
    </div>
  )
}

// ═══════════════════════════════════════════════════════
//  HISTORY TAB
// ═══════════════════════════════════════════════════════
function HistoryTab({ runs, brandName, onClear }: { runs: ScanRun[], brandName: string, onClear: ()=>void }) {
  if (!runs.length) return (
    <div style={{textAlign:'center',padding:'40px 20px',color:'var(--muted)',fontSize:11}}>No runs yet.</div>
  )
  return (
    <div>
      {runs.map(r=>{
        const a = buildAnalytics(r.orders)
        return (
          <div key={r.runId} style={{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:8,padding:'12px',marginBottom:10}}>
            <div style={{display:'flex',justifyContent:'space-between',marginBottom:6}}>
              <span style={{color:'var(--accent)',fontWeight:700,fontSize:12}}>{r.dateRange}</span>
              <span style={{color:'var(--muted)',fontSize:9}}>{r.createdAt}</span>
            </div>
            <div style={{display:'flex',gap:16,fontSize:10,marginBottom:8,flexWrap:'wrap'}}>
              <span style={{color:'var(--muted)'}}>Found: <b style={{color:'var(--text)'}}>{r.found}</b></span>
              {a&&<><span style={{color:'var(--muted)'}}>Rev: <b style={{color:'var(--text)'}}>{fmtRs(a.totalRevenue)}</b></span>
              <span style={{color:'var(--muted)'}}>COD: <b style={{color:'var(--text)'}}>{a.codPct}%</b></span>
              <span style={{color:'var(--muted)'}}>Avg: <b style={{color:'var(--text)'}}>{fmtRs(a.avgOrderVal)}</b></span></>}
            </div>
            {a&&a.topCities.length>0&&(
              <div style={{fontSize:9,color:'var(--muted)',marginBottom:8}}>
                {a.topCities.slice(0,4).map(c=>`${c.city} (${c.count})`).join(' · ')}
              </div>
            )}
            <div style={{display:'flex',gap:6}}>
              <button onClick={()=>download(buildCSV(r.orders),`${brandName}_${r.dateRange}.csv`)}
                style={{flex:1,background:'none',border:'1px solid var(--border)',color:'var(--text)',padding:'7px',borderRadius:6,fontSize:10,fontWeight:700,cursor:'pointer'}}>↓ CSV</button>
              <button onClick={()=>download(buildReport(r.orders,brandName,r.dateRange),`${brandName}_report_${r.dateRange}.csv`)}
                style={{flex:1,background:'none',border:'1px solid var(--border)',color:'var(--text)',padding:'7px',borderRadius:6,fontSize:10,fontWeight:700,cursor:'pointer'}}>↓ Report</button>
            </div>
          </div>
        )
      })}
      <button onClick={()=>{if(confirm('Clear all history?'))onClear()}}
        style={{width:'100%',background:'none',border:'1px solid var(--border)',color:'var(--muted)',padding:8,borderRadius:6,fontSize:10,marginTop:4,cursor:'pointer'}}>
        Clear History
      </button>
    </div>
  )
}

// ═══════════════════════════════════════════════════════
//  SETTINGS TAB
// ═══════════════════════════════════════════════════════
function SettingsTab({ brands, activeBrand, onDelete, onUpdate }: any) {
  return (
    <div>
      <div style={{fontSize:9,color:'var(--muted)',textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:10}}>Manage Brands</div>
      {brands.map((b: Brand)=>(
        <div key={b.id} style={{background:'var(--surface)',border:`1px solid ${b.id===activeBrand.id?'var(--accent)':'var(--border)'}`,borderRadius:8,padding:'12px',marginBottom:8}}>
          <div style={{fontWeight:700,color:'var(--accent)',fontSize:12,marginBottom:2}}>{b.name}</div>
          <div style={{fontSize:9,color:'var(--muted)',marginBottom:8,lineHeight:1.8}}>
            {b.subdomain}.shiprocket.co · slug: {b.slug} · ~{b.avgPerDay}/day<br/>
            anchor: #{b.anchorId} ({b.anchorDate}) · {b.regressionPoints?.length||0} cal pts
          </div>
          <button onClick={()=>onDelete(b.id)}
            style={{background:'none',border:'1px solid var(--red)',color:'var(--red)',padding:'5px 12px',borderRadius:4,fontSize:9,fontWeight:700,cursor:'pointer'}}>
            Delete
          </button>
        </div>
      ))}

      <div style={{marginTop:20,padding:'12px',background:'var(--surface)',border:'1px solid var(--border)',borderRadius:8,fontSize:9,color:'var(--muted)',lineHeight:2}}>
        <div style={{color:'var(--accent)',fontWeight:700,marginBottom:6,fontSize:10}}>About</div>
        Data stored in browser localStorage · No server-side data storage<br/>
        Scraping runs via Vercel Edge Functions (different IPs)<br/>
        Free forever · Open source by RahulJ
      </div>
    </div>
  )
}
