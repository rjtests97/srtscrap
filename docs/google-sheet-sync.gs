/**
 * srtscrap → Google Sheet sync + CXO dashboard (Apps Script web app)
 * ------------------------------------------------------------------
 * Receives orders from the scraper (manual "Sync to Sheets" button AND the
 * daily Vercel cron), upserts them into an "Orders" sheet (deduped by Order ID),
 * and rebuilds a "Dashboard" sheet with KPIs + charts on every sync.
 *
 * SETUP (one time, ~3 min):
 *  1. Create a Google Sheet. Extensions → Apps Script.
 *  2. Delete the sample code, paste THIS whole file, Save.
 *  3. Deploy → New deployment → type "Web app".
 *       - Execute as: Me
 *       - Who has access: Anyone          ← required, else "Failed to fetch"
 *     Click Deploy, authorize, and COPY the Web app URL (ends in /exec).
 *  4. Put that URL in the app (Settings → Sheets URL) and/or as the Vercel env
 *     var  SHEETS_URL.
 *  To update later: Deploy → Manage deployments → Edit → Deploy (same URL).
 *  Tip: open the /exec URL in a browser any time to force-refresh the dashboard.
 */

var TZ = 'Asia/Kolkata';
var H = ['Order ID','Date','Time','Value','Payment','Status','Location','Pincode','dateYMD','Updated'];
var MON = { Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12' };

// Resolve a row's YYYY-MM-DD. Prefers the dateYMD column, but falls back to
// parsing the human "Date" column ("23 May 2026") so rows written by the older
// 8-column script (no dateYMD) are still counted.
function rowYMD(r) {
  var dy = String(r[8] || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(dy)) return dy.substring(0, 10);
  var m = String(r[1] || '').match(/^(\d{1,2})\s+(\w{3})\s+(\d{4})/);
  return m ? (m[3] + '-' + (MON[m[2]] || '00') + '-' + ('0' + m[1]).slice(-2)) : '';
}

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents || '{}');
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('Orders') || ss.insertSheet('Orders');

    if (data.mode === 'replace') sheet.clearContents();
    if (sheet.getLastRow() === 0) { sheet.appendRow(H); sheet.setFrozenRows(1); }

    // Upsert by Order ID so re-runs / daily syncs never duplicate.
    var lastRow = sheet.getLastRow(), map = {};
    if (lastRow > 1) {
      var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
      for (var i = 0; i < ids.length; i++) map[String(ids[i][0])] = i + 2;
    }
    var now = new Date(), add = [], updated = 0;
    (data.orders || []).forEach(function (o) {
      var row = [String(o.orderId), o.orderDate || '', o.orderTime || '', o.value || '',
                 o.payment || '', o.status || '', o.location || '', o.pincode || '', o.dateYMD || '', now];
      var r = map[String(o.orderId)];
      if (r) { sheet.getRange(r, 1, 1, row.length).setValues([row]); updated++; }
      else add.push(row);
    });
    if (add.length) sheet.getRange(sheet.getLastRow() + 1, 1, add.length, H.length).setValues(add);

    // Rebuild the dashboard, but never fail the upsert over it — surface any
    // error in the response instead so it's visible in the app's sync status.
    var dash = 'ok';
    try { rebuildDashboard(ss); } catch (de) { dash = 'error: ' + String(de); }
    return json({ ok: true, added: add.length, updated: updated, dashboard: dash });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

// Open the /exec URL in a browser to force-rebuild the dashboard and see any error.
function doGet() {
  try {
    rebuildDashboard(SpreadsheetApp.getActiveSpreadsheet());
    return json({ ok: true, msg: 'Dashboard rebuilt — srtscrap sheet sync is live' });
  } catch (e) {
    return json({ ok: false, where: 'dashboard', error: String(e) });
  }
}

function json(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function dstr(d) { return Utilities.formatDate(d, TZ, 'yyyy-MM-dd'); }
function addDays(s, n) { var d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return dstr(d); }

function rebuildDashboard(ss) {
  var orders = ss.getSheetByName('Orders');
  if (!orders || orders.getLastRow() < 2) return;
  var rows = orders.getRange(2, 1, orders.getLastRow() - 1, H.length).getValues();

  var today = dstr(new Date());
  var yest  = addDays(today, -1);
  var wdMap = { Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6, Sun:7 };
  var dow   = wdMap[Utilities.formatDate(new Date(), TZ, 'EEE')] || 1;
  var wStart = addDays(today, -(dow - 1));
  var mStart = today.substring(0, 8) + '01';

  var cToday = 0, cYest = 0, cWtd = 0, cMtd = 0, total = 0, revToday = 0, revMtd = 0;
  var loc = {}, pin = {}, status = {}, daily = {};
  rows.forEach(function (r) {
    var dy = rowYMD(r); if (!dy) return;
    var st = String(r[5] || ''), lc = String(r[6] || ''), pc = String(r[7] || '');
    var val = parseFloat(String(r[3] || '').replace(/[^0-9.]/g, '')) || 0;
    total++;
    if (dy === today) { cToday++; revToday += val; }
    if (dy === yest) cYest++;
    if (dy >= wStart && dy <= today) cWtd++;
    if (dy >= mStart && dy <= today) { cMtd++; revMtd += val; }
    if (lc && lc !== 'N/A') loc[lc] = (loc[lc] || 0) + 1;
    if (pc && pc !== 'N/A') pin[pc] = (pin[pc] || 0) + 1;
    if (st && st !== 'N/A') status[st] = (status[st] || 0) + 1;
    if (dy >= addDays(today, -29) && dy <= today) daily[dy] = (daily[dy] || 0) + 1;
  });

  var topN = function (obj, n) {
    return Object.keys(obj).map(function (k) { return [k, obj[k]]; })
      .sort(function (a, b) { return b[1] - a[1]; }).slice(0, n);
  };

  var dash = ss.getSheetByName('Dashboard') || ss.insertSheet('Dashboard', 0);
  dash.getCharts().forEach(function (c) { dash.removeChart(c); });
  dash.clear();

  dash.getRange('A1').setValue('📊 CXO Dashboard').setFontSize(16).setFontWeight('bold');
  dash.getRange('A2').setValue('Updated: ' + Utilities.formatDate(new Date(), TZ, 'dd MMM yyyy, HH:mm') + ' IST');

  // KPI cards (A4:B10)
  var kpis = [
    ['Today', cToday], ['Yesterday', cYest], ['Week to date', cWtd],
    ['Month to date', cMtd], ['Total tracked', total],
    ['Revenue (today)', Math.round(revToday)], ['Revenue (MTD)', Math.round(revMtd)]
  ];
  dash.getRange(4, 1, kpis.length, 2).setValues(kpis);
  dash.getRange(4, 1, kpis.length, 1).setFontWeight('bold');
  dash.getRange(4, 2, kpis.length, 1).setFontSize(13).setFontColor('#0a7d33');

  // Top Locations (D4:E..)
  var tl = topN(loc, 10);
  dash.getRange('D4').setValue('Top Locations').setFontWeight('bold');
  dash.getRange(5, 4, 1, 2).setValues([['Location', 'Orders']]).setFontWeight('bold');
  if (tl.length) dash.getRange(6, 4, tl.length, 2).setValues(tl);

  // Top Pincodes (G4:H..)
  var tp = topN(pin, 10);
  dash.getRange('G4').setValue('Top Pincodes').setFontWeight('bold');
  dash.getRange(5, 7, 1, 2).setValues([['Pincode', 'Orders']]).setFontWeight('bold');
  if (tp.length) dash.getRange(6, 7, tp.length, 2).setValues(tp.map(function (x) { return [String(x[0]), x[1]]; }));

  // Status breakdown (J4:K..)
  var tsr = topN(status, 12);
  dash.getRange('J4').setValue('Status Breakdown').setFontWeight('bold');
  dash.getRange(5, 10, 1, 2).setValues([['Status', 'Orders']]).setFontWeight('bold');
  if (tsr.length) dash.getRange(6, 10, tsr.length, 2).setValues(tsr);

  // Daily helper data for the 30-day chart, parked out to the right (N:O)
  var days = [];
  for (var i = 29; i >= 0; i--) { var d = addDays(today, -i); days.push([d, daily[d] || 0]); }
  dash.getRange(4, 14, 1, 2).setValues([['Date', 'Orders']]);
  dash.getRange(5, 14, days.length, 2).setValues(days);

  // Charts below the tables
  dash.insertChart(dash.newChart().setChartType(Charts.ChartType.COLUMN)
    .addRange(dash.getRange(4, 14, days.length + 1, 2))
    .setPosition(20, 1, 0, 0)
    .setOption('title', 'Orders — last 30 days')
    .setOption('legend', { position: 'none' })
    .setOption('width', 560).setOption('height', 300)
    .build());

  if (tl.length) {
    dash.insertChart(dash.newChart().setChartType(Charts.ChartType.BAR)
      .addRange(dash.getRange(5, 4, tl.length + 1, 2))
      .setPosition(20, 8, 0, 0)
      .setOption('title', 'Top Locations')
      .setOption('legend', { position: 'none' })
      .setOption('width', 460).setOption('height', 300)
      .build());
  }

  if (tsr.length) {
    dash.insertChart(dash.newChart().setChartType(Charts.ChartType.PIE)
      .addRange(dash.getRange(5, 10, tsr.length + 1, 2))
      .setPosition(36, 1, 0, 0)
      .setOption('title', 'Status mix')
      .setOption('width', 460).setOption('height', 300)
      .build());
  }
}
