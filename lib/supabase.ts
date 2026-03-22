import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

export const supabase = createClient(supabaseUrl, supabaseKey)

export type Brand = {
  id: string
  name: string
  subdomain: string
  slug: string
  company_name: string
  anchor_id: number
  anchor_date: string
  avg_per_day: number
  regression_points: Array<{date: string, id: number}>
  created_at: string
}

export type Order = {
  order_id: number
  brand_id: string
  slug: string
  order_date: string
  order_time: string
  date_ymd: string
  value: string
  value_num: number
  payment: string
  status: string
  pincode: string
  location: string
  scan_run_id: string
}

export type ScanRun = {
  id: string
  brand_id: string
  from_date: string
  to_date: string
  found: number
  scanned: number
  date_range: string
  created_at: string
}
