# Shiprocket Order Scrapper — Web Edition
## by RahulJ · Free Forever

### Deploy to Vercel (1 click, free)

1. Push this repo to GitHub
2. Go to vercel.com → New Project → Import your repo
3. Click Deploy — done!

### How it works

- **Scraping** runs server-side via Vercel Edge Functions
  - Different IP per Vercel region (18 global regions)
  - No browser rate limits
  - 5 min timeout per scan on free tier

- **Data** stored in browser localStorage
  - No database needed
  - All data stays in your browser
  - Up to 50 scan runs per brand

### Adding a brand

1. Get your brand's Shiprocket subdomain (e.g. `everlasting` from `everlasting.shiprocket.co`)
2. Find one order ID from that brand (use the Shiprocket tracking page)
3. Note the date of that order
4. Click + ADD BRAND and fill in the details

### Free tier limits

- Vercel: 100GB bandwidth, 100k function invocations/month
- No credit card needed
- localStorage: ~10MB per brand (handles 30,000+ orders)

### Tips for best results

- Start with a small date range (1-2 days) to verify it's working
- Use 3-5 concurrent fetches to avoid rate limits
- After first scan, regression points are built — subsequent scans are much faster
