import { NextRequest, NextResponse } from 'next/server'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
export const runtime = 'nodejs'

const dir = '/tmp/srtscraper'
const file = (sub: string) => join(dir, `runs_${sub.replace(/[^a-z0-9]/gi,'_')}.json`)

export async function GET(req: NextRequest) {
  const sub = req.nextUrl.searchParams.get('subdomain') || ''
  if (!sub) return NextResponse.json({ runs: [] })
  try {
    if (!existsSync(file(sub))) return NextResponse.json({ runs: [], subdomain: sub })
    return NextResponse.json(JSON.parse(readFileSync(file(sub), 'utf-8')))
  } catch { return NextResponse.json({ runs: [] }) }
}

export async function POST(req: NextRequest) {
  const { subdomain, runs } = await req.json()
  if (!subdomain) return NextResponse.json({ ok: false })
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(file(subdomain), JSON.stringify({ subdomain, runs, updatedAt: Date.now() }))
    return NextResponse.json({ ok: true, count: runs?.length || 0 })
  } catch (e: any) { return NextResponse.json({ ok: false, error: e.message }) }
}
