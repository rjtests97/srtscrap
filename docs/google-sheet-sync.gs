/**
 * srtscrap → Google Sheet sync (Apps Script web app)
 * ---------------------------------------------------
 * Receives orders from the scraper (manual "Sync to Sheets" button AND the
 * daily Vercel cron) and upserts them into the active sheet, deduped by Order ID.
 *
 * SETUP (one time, ~3 min):
 *  1. Create a Google Sheet. Extensions → Apps Script.
 *  2. Delete the sample code, paste THIS whole file, Save.
 *  3. Deploy → New deployment → type "Web app".
 *       - Execute as: Me
 *       - Who has access: Anyone
 *     Click Deploy, authorize, and COPY the Web app URL (ends in /exec).
 *  4. Put that URL where it's needed:
 *       - In the app: Settings → paste into the Sheets URL field, OR
 *       - For the daily cron: Vercel → Project → Settings → Environment
 *         Variables → add  SHEETS_URL = <the /exec url>
 *  To update the script later, Deploy → Manage deployments → Edit → Deploy
 *  (keep the same URL).
 */

var HEADERS = ['Order ID', 'Date', 'Time', 'Value', 'Payment', 'Status', 'Location', 'Pincode', 'dateYMD', 'Updated'];

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents || '{}');
    var orders = body.orders || [];
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();

    // Ensure header row.
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(HEADERS);
      sheet.setFrozenRows(1);
    }

    // Map existing Order IDs -> row number (for upsert / dedupe).
    var lastRow = sheet.getLastRow();
    var idToRow = {};
    if (lastRow > 1) {
      var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
      for (var i = 0; i < ids.length; i++) idToRow[String(ids[i][0])] = i + 2;
    }

    var now = new Date();
    var added = 0, updated = 0;
    var appendRows = [];

    for (var j = 0; j < orders.length; j++) {
      var o = orders[j];
      var row = [
        String(o.orderId), o.orderDate || '', o.orderTime || '', o.value || '',
        o.payment || '', o.status || '', o.location || '', o.pincode || '',
        o.dateYMD || '', now
      ];
      var existing = idToRow[String(o.orderId)];
      if (existing) {
        sheet.getRange(existing, 1, 1, row.length).setValues([row]);
        updated++;
      } else {
        appendRows.push(row);
        added++;
      }
    }
    if (appendRows.length) {
      sheet.getRange(sheet.getLastRow() + 1, 1, appendRows.length, HEADERS.length).setValues(appendRows);
    }

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, added: added, updated: updated }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// Lets you open the /exec URL in a browser to confirm it's live.
function doGet() {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, msg: 'srtscrap sheet sync is live' }))
    .setMimeType(ContentService.MimeType.JSON);
}
