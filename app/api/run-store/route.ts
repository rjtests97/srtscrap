// Stores run data posted by browser after scans
// Used by Vercel Cron to get historical data for daily reports
import { NextRequest, NextResponse } from 'next/server'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'

export const runtime = 'nodejs'

const TMP = '/tmp/srtscraper'
const file = (sub: string) => join(TMP, `runs_${sub.replace(/[^a-z0-9]/gi,'_')}.json`)

// In-memory cache — survives within same Vercel instance warm period (~15min)
const memCache: Record<string, any> = {}

export async function GET(req: NextRequest) {
  const sub = req.nextUrl.searchParams.get('subdomain') || ''
  if (!sub) return NextResponse.json({ runs: [] })

  // Check memory cache first (same instance)
  if (memCache[sub]) return NextResponse.json(memCache[sub])

  // Check /tmp
  try {
    if (existsSync(file(sub))) {
      const data = JSON.parse(readFileSync(file(sub), 'utf-8'))
      memCache[sub] = data
      return NextResponse.json(data)
    }
  } catch {}

  return NextResponse.json({ runs: [], subdomain: sub })
}

export async function POST(req: NextRequest) {
  const { subdomain, runs } = await req.json()
  if (!subdomain || !runs) return NextResponse.json({ ok: false })

  const data = { subdomain, runs, updatedAt: Date.now() }

  // Store in memory
  memCache[subdomain] = data

  // Store in /tmp
  try {
    if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true })
    writeFileSync(file(subdomain), JSON.stringify(data))
  } catch {}

  return NextResponse.json({ ok: true, count: runs.length, updatedAt: data.updatedAt })
}
