import { NextRequest } from 'next/server'
import { fetchOrder } from '@/lib/scraper'

export const runtime = 'nodejs'
export const maxDuration = 60

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// IDs scanned per 60s call at given concurrency + 250ms delay
// concurrency=5: 20 ids/s × 50s usable = 1000 ids. Use 800 for safety.
const CHUNK = 800

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { subdomain, slug, concurrency = 5, mode = 'date',
          fromDate, toDate,
          scanStart, scanEnd, originalStart, totalSpan, runId,
          startId, endId, useAuto, stopAfter = 200 } = body

  const encoder = new TextEncoder()
  const stream  = new TransformStream()
  const writer  = stream.writable.getWriter()

  const send = (type: string, data: any) => {
    try { writer.write(encoder.encode(`data: ${JSON.stringify({ type, ...data })}\n\n`)) } catch {}
  }

  const ping = setInterval(() => {
    try { writer.write(encoder.encode(': ping\n\n')) } catch {}
  }, 4000)

  ;(async () => {
    try {
      const orders: any[] = []
      let scanned = 0, matched = 0, rlStreak = 0

      if (mode === 'manual') {
        const thisEnd = Math.min(scanStart + CHUNK - 1, scanEnd)
        send('log', { msg: `Scanning #${scanStart}–#${thisEnd}`, cls: 'info' })

        let misses = 0, stopped = false
        for (let base = scanStart; base <= thisEnd && !stopped; base += concurrency) {
          const ids: number[] = []
          for (let id = base; id <= Math.min(base + concurrency - 1, thisEnd); id++) ids.push(id)
          const fetched = await Promise.all(ids.map(id => fetchOrder(subdomain, id)))
          for (let i = 0; i < ids.length && !stopped; i++) {
            const o = fetched[i]; scanned++
            if (o && o !== 'rl' && o.slug === slug) {
              orders.push(o); matched++; misses = 0
              send('order', { order: o })
              send('log', { msg: `#${ids[i]}  ${o.orderDate}  ${o.value}  ${o.payment}  ${o.location}`, cls: 'ok' })
            } else if (o !== 'rl') misses++
            if (useAuto && misses >= stopAfter) {
              send('log', { msg: `Auto-stopped: ${stopAfter} consecutive misses`, cls: 'info' })
              stopped = true
            }
          }
          send('progress', { done: (originalStart||scanStart) + scanned, total: totalSpan||0, found: matched })
          await sleep(250)
        }

        if (!stopped && thisEnd < scanEnd) {
          send('chunk_done', {
            mode:'manual', nextStart:thisEnd+1, scanEnd,
            originalStart:originalStart||scanStart, totalSpan,
            startId, endId, useAuto, stopAfter,
            fromDate, toDate,
            runId: runId||Date.now().toString(), chunkOrders:orders
          })
        } else {
          send('done', { matched:orders.length, scanned, runId:runId||Date.now().toString() })
        }

      } else {
        // Date scan — scanStart/scanEnd already determined by /api/bounds call
        const chunkEnd = Math.min(scanStart + CHUNK - 1, scanEnd)
        send('log', { msg: `Scanning #${scanStart}–#${chunkEnd} of #${scanEnd}`, cls: 'info' })
        send('start', { total: totalSpan||scanEnd-scanStart+1, scanStart, scanEnd })

        for (let base = scanStart; base <= chunkEnd; base += concurrency) {
          const ids: number[] = []
          for (let id = base; id <= Math.min(base + concurrency - 1, chunkEnd); id++) ids.push(id)
          const fetched = await Promise.all(ids.map(id => fetchOrder(subdomain, id)))
          for (let i = 0; i < ids.length; i++) {
            const o = fetched[i]; scanned++
            if (o === 'rl') { rlStreak++; continue }
            rlStreak = Math.max(0, rlStreak - 1)
            if (o && o.slug === slug && o.dateYMD && o.dateYMD >= fromDate && o.dateYMD <= toDate) {
              orders.push(o); matched++
              send('order', { order: o })
              send('log', { msg: `#${ids[i]}  ${o.orderDate}  ${o.value}  ${o.payment}  ${o.location}  ${o.pincode}`, cls: 'ok' })
            }
          }
          send('progress', { done: (originalStart||scanStart)+scanned, total: totalSpan||scanEnd-scanStart+1, found: matched })
          await sleep(rlStreak > 3 ? Math.min(rlStreak*1500, 10000) : 250)
        }

        if (chunkEnd < scanEnd) {
          send('chunk_done', {
            mode:'date', nextStart:chunkEnd+1, scanEnd,
            originalStart:originalStart||scanStart, totalSpan:totalSpan||scanEnd-scanStart+1,
            fromDate, toDate,
            runId:runId||Date.now().toString(), chunkOrders:orders
          })
        } else {
          send('done', { matched:orders.length, scanned, runId:runId||Date.now().toString() })
        }
      }

    } catch (err: any) {
      send('error', { msg: err.message })
      send('done', { matched:0, scanned:0, runId:runId||Date.now().toString() })
    } finally {
      clearInterval(ping)
      writer.close().catch(()=>{})
    }
  })()

  return new Response(stream.readable, {
    headers: {
      'Content-Type':'text/event-stream',
      'Cache-Control':'no-cache, no-transform',
      'Connection':'keep-alive',
      'X-Accel-Buffering':'no',
    }
  })
}
