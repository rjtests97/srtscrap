# Daily auto-scan → Google Sheet (no device needed)

Once set up, Vercel runs the scan every morning on its own, scrapes **yesterday's**
orders, and appends them to your Google Sheet. Nothing to keep open. Free.

## 1. Create the Google Sheet sync (one time, ~3 min)

1. Make a new Google Sheet.
2. **Extensions → Apps Script**. Delete the sample, paste everything from
   [`docs/google-sheet-sync.gs`](google-sheet-sync.gs), **Save**.
3. **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
   - **Deploy**, authorize, and **copy the Web app URL** (ends in `/exec`).
4. (Optional sanity check) open that URL in a browser — you should see
   `{"ok":true,"msg":"srtscrap sheet sync is live"}`.

## 2. Set Vercel environment variables

Vercel → your project → **Settings → Environment Variables**. Add these
(Production), then **redeploy** so they take effect:

| Variable | Value | Where to find it |
|---|---|---|
| `SHEETS_URL` | the `/exec` URL from step 1 | Apps Script deployment |
| `BRAND_SUBDOMAIN` | `minnies` | the part before `.shiprocket.co` |
| `BRAND_NAME` | `Minnies` | any label |
| `BRAND_ANCHOR_ID` | e.g. `65217` | a known order ID (app → brand anchor) |
| `BRAND_ANCHOR_DATE` | e.g. `2026-05-01` | that order's date, `YYYY-MM-DD` |
| `BRAND_ID_PREFIX` | usually empty | only if your IDs have a letter prefix |
| `CRON_SECRET` | any random string (optional) | lets you trigger it manually |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | optional | adds a daily Telegram ping |

> The anchor is just a starting point the scan walks from to find yesterday's
> ID range — any real order ID + its date works. A more recent one = a shorter
> walk.

## 3. Schedule

Already configured in `vercel.json`:

```json
{ "crons": [ { "path": "/api/cron/scan", "schedule": "30 2 * * *" } ] }
```

`30 2 * * *` = 02:30 UTC = **08:00 IST** daily. Change the time by editing the
cron string (it's UTC).

## 4. Test it now (don't wait until morning)

With `CRON_SECRET` set, open in a browser:

```
https://srtscrap.vercel.app/api/cron/scan?secret=YOUR_SECRET&date=2026-06-24
```

You'll get a JSON summary (`found`, `range`, `sheet`) and the rows should
appear in your Sheet. Drop `&date=...` to scan yesterday.

## Notes

- Rows are **upserted by Order ID**, so re-running a day never duplicates —
  it updates (e.g. a Pending order that later shows Delivered).
- The Sheet is now your durable history; the in-browser cache and CSV import
  are only for manual/backfill scans.
- A single daily run scans ~a few hundred IDs and finishes well within the 60s
  function limit.
