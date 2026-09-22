/**
 * MM Reverse — Google Apps Script BRIDGE (sheets ⇄ the live app).
 *
 * Why a bridge: Meesho's domain policy blocks inbound calls to Apps Script web apps, but OUTBOUND
 * calls from Apps Script are free. So this script PUSHES the day's pending crates to the app and
 * PULLS scan results back — the app never calls the sheet.
 *
 * Setup: open the MASTER sheet → Extensions → Apps Script → paste this file → Save. Reload the
 * sheet; a "MM Reverse" menu appears. Use "Sync out" to push pending crates, "Sync in" to pull
 * scan results, or "Install auto-sync" once to run both every 5 minutes automatically.
 */

// ---- config -----------------------------------------------------------------
var APP_URL = 'https://mm-reverse.onrender.com';          // the live Render app
var TOKEN   = 'eeBcLyjyNomuc6EfH2WA99sqHc9K-JDO';          // must match BRIDGE_TOKEN on the app
var MASTER_ID = '1zGfOjfPzVHzyMvx7oObkmyd-UUaEMWXjapIvxGVNyPQ';
var ADMIN_TAB = 'Admin';
var SKU_TAB   = 'EAN SKU Details';
var SCAN_TAB_PREFIX = 'Scan Data ';
// Once-a-day auto-sync times (24h, in the script's timezone). Change these to fit your shift.
var SYNC_OUT_HOUR = 5;    // ~5 AM: fresh-load the day's pending crates BEFORE the 6 AM shift
var SYNC_IN_HOUR  = 18;   // ~6 PM: after the 5 PM shift ends, write the day's scans back to the sheets

// ---- menu -------------------------------------------------------------------
function onOpen() {
  SpreadsheetApp.getUi().createMenu('MM Reverse')
    .addItem('Sync out — push pending crates to app', 'syncOut')
    .addItem('Sync in — pull scan results into sheets', 'syncIn')
    .addItem('Sync both now', 'syncBoth')
    .addItem('Fresh reload — clear + load today (new day)', 'morningLoad')
    .addSeparator()
    .addItem('Install daily auto-sync (morning out · evening in)', 'installDailyTriggers')
    .addItem('Remove all auto-sync', 'removeTrigger')
    .addToUi();
}
function syncBoth() { const o = syncOut(); const i = syncIn(); toast(`Out: ${o.rows} rows · In: ${i.written} scan rows`); }
function toast(m) { try { SpreadsheetApp.getActive().toast(m, 'MM Reverse', 8); } catch (_) { Logger.log(m); } }

// ---- SYNC OUT: read every rider's latest date tab → push pending crates ------
function morningLoad() { return syncOut(true); }   // fresh reset + load — the daily morning trigger
function syncOut(reset) {
  var master = SpreadsheetApp.openById(MASTER_ID);
  var skus = buildSkuList(master);
  var shops = buildPpShopMap(master);
  var dir = readAdmin(master);
  var rows = [];
  dir.forEach(function (rd) {
    if (!rd.sheetId) return;
    var rss; try { rss = SpreadsheetApp.openById(rd.sheetId); } catch (_) { return; }
    var tab = latestDateTab(rss); if (!tab) return;
    var date = tab.getName();
    var dv = tab.getDataRange().getValues(); if (dv.length < 2) return;
    var dh = cols(dv[0]);
    var cCrate = pick(dh, ['crate_number', 'crate number', 'crate']);
    var cSku = pick(dh, ['sku_id', 'sku id', 'sku']);
    var cPP = pick(dh, ['source_hub', 'pp code', 'pp_code', 'source hub']);
    var cDest = pick(dh, ['destination_hub', 'destination hub', 'pc']);
    var cRto = pick(dh, ['rto_qty', 'rto qty', 'rto']);
    var cCreat = pick(dh, ['created_at_source_timestamp', 'created_at', 'created at']);
    var cWh = pick(dh, ['wh_processing_date', 'wh date', 'wh_date']);
    for (var r = 1; r < dv.length; r++) {
      var row = dv[r];
      var crate = cCrate >= 0 ? String(row[cCrate] || '').trim() : '';
      if (!crate) continue;
      var pp = cPP >= 0 ? String(row[cPP] || '').trim() : '';
      rows.push({
        rider_phone: rd.phone, rider_name: rd.name,
        pp_code: pp, shop_name: shops[pp] || '',
        pc: cDest >= 0 ? String(row[cDest] || '').trim() : '',
        crate_id: crate, sku_id: cSku >= 0 ? String(row[cSku] || '').trim() : '',
        rto_qty: cRto >= 0 ? toInt(row[cRto]) : 0,
        wh_date: cWh >= 0 ? String(row[cWh] || '') : date,
        created: cCreat >= 0 ? String(row[cCreat] || '') : '',
      });
    }
  });
  var res = post('/api/ingest', { skus: skus, rows: rows, reset: !!reset });
  toast('Sync out' + (reset ? ' (fresh reset)' : '') + ': pushed ' + rows.length + ' rows → ' + (res.added != null ? res.added + ' crates' : JSON.stringify(res)));
  return { rows: rows.length, res: res };
}

// ---- SYNC IN: pull scan results → write a "Scan Data <date>" tab per rider ----
function syncIn() {
  var out = fetchJson('/api/scan-export');
  var cols = out.cols || [];
  var rows = out.rows || [];
  var dir = readAdmin(SpreadsheetApp.openById(MASTER_ID));
  var byPhone = {}; dir.forEach(function (d) { byPhone[d.phone] = d; });
  // group export rows by rider phone
  var groups = {};
  rows.forEach(function (r) { (groups[r.rider_phone] = groups[r.rider_phone] || []).push(r); });
  var date = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var ci = {}; cols.forEach(function (c, i) { ci[c] = i; });
  var kc = ci['crate_number'], ks = ci['sku_id'];   // upsert key = crate × sku
  var written = 0;
  Object.keys(groups).forEach(function (phone) {
    var rd = byPhone[phone]; if (!rd || !rd.sheetId) return;
    var rss; try { rss = SpreadsheetApp.openById(rd.sheetId); } catch (_) { return; }
    var name = SCAN_TAB_PREFIX + date;
    var tab = rss.getSheetByName(name);
    // ACCUMULATE (never clear): read existing rows, then upsert each scan by crate×sku. This way
    // a free-tier spin-down that wipes the app can never erase scans already written to the sheet.
    var existing = [];
    if (!tab) { tab = rss.insertSheet(name); tab.appendRow(cols); tab.setFrozenRows(1); }
    else { var vv = tab.getDataRange().getValues(); if (vv.length > 1) existing = vv.slice(1); }
    var map = {};
    existing.forEach(function (r, idx) { map[String(r[kc]) + '|' + String(r[ks])] = idx; });
    groups[phone].forEach(function (r) {
      var arr = cols.map(function (c) { return r[c] != null ? r[c] : ''; });
      var key = String(r.crate_number) + '|' + String(r.sku_id);
      if (map[key] != null) existing[map[key]] = arr;                 // update in place
      else { existing.push(arr); map[key] = existing.length - 1; }    // append new
      written++;
    });
    if (existing.length) tab.getRange(2, 1, existing.length, cols.length).setValues(existing);
  });
  toast('Sync in: merged ' + written + ' scan rows into Scan Data ' + date);
  return { written: written };
}

// ---- auto-sync trigger ------------------------------------------------------
// Two once-a-day triggers: load pending in the morning, save scans in the evening.
// Manual "Sync out / Sync in / Sync both now" from the menu still work anytime, independently.
function installDailyTriggers() {
  removeTrigger();   // clear any existing MM Reverse triggers first, so nothing ever stacks
  ScriptApp.newTrigger('morningLoad').timeBased().everyDays(1).atHour(SYNC_OUT_HOUR).create();   // fresh load before the shift
  ScriptApp.newTrigger('syncIn').timeBased().everyDays(1).atHour(SYNC_IN_HOUR).create();           // save scans after the shift
  toast('Daily auto-sync on — fresh load ~' + SYNC_OUT_HOUR + ':00, save scans ~' + SYNC_IN_HOUR + ':00. Old triggers removed. (Manual Sync still works anytime.)');
}
function removeTrigger() {
  var fns = ['syncBoth', 'syncOut', 'syncIn', 'morningLoad'];
  ScriptApp.getProjectTriggers().forEach(function (t) { if (fns.indexOf(t.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(t); });
}

// ---- HTTP -------------------------------------------------------------------
// Calls the app, retrying through a free-tier cold start (502/503/429/500 while it wakes, ~50s).
function callApi(path, options) {
  options = options || {};
  options.headers = { 'x-bridge-token': TOKEN };
  options.muteHttpExceptions = true;
  var last = '';
  for (var i = 0; i < 8; i++) {
    try {
      var r = UrlFetchApp.fetch(APP_URL + path, options);
      var code = r.getResponseCode(), txt = r.getContentText();
      if (code >= 200 && code < 300) { try { return JSON.parse(txt); } catch (e) { throw new Error('bad JSON from app: ' + txt.slice(0, 200)); } }
      last = code + ': ' + txt.slice(0, 150);
      if (code === 502 || code === 503 || code === 429 || code === 500) { Utilities.sleep(10000); continue; } // waking → wait & retry
      throw new Error('app ' + last);
    } catch (e) {
      var msg = String((e && e.message) || e);
      if (msg.indexOf('app ') === 0 || msg.indexOf('bad JSON') === 0) throw e;   // genuine app error → don't loop
      last = msg; Utilities.sleep(10000);                                          // network hiccup ("Address unavailable") → retry
    }
  }
  throw new Error('app unreachable after retries (' + last + ')');
}
function post(path, body) { return callApi(path, { method: 'post', contentType: 'application/json', payload: JSON.stringify(body) }); }
function fetchJson(path) { return callApi(path, { method: 'get' }); }

// ---- master readers ---------------------------------------------------------
// Admin directory → [{ phone, name, route, sheetId }]
function readAdmin(master) {
  // Find the directory by name, else by columns (a phone col + a route/name col) — robust to naming.
  var sh = findSheetByCols(master, ADMIN_TAB, [['rider number', 'phone', 'number', 'contact'], ['route no', 'route', 'rider name', 'name']]);
  if (!sh) throw new Error('Could not find the rider directory tab (needs a phone column + a route/name column). Rename it to "Admin Tab" or set ADMIN_TAB.');
  var v = sh.getDataRange().getValues(); var h = cols(v[0]);
  var cName = pick(h, ['rider name', 'name']);
  var cPhone = pick(h, ['rider number', 'phone', 'number', 'contact']);
  var cRoute = pick(h, ['route no', 'route', 'route no.']);
  var cLink = pick(h, ['sheet link', 'link', 'sheet']);
  var out = [];
  for (var i = 1; i < v.length; i++) {
    var phone = digits10(v[i][cPhone]); if (!phone) continue;
    var route = cRoute >= 0 ? String(v[i][cRoute] || '').trim() : '';
    out.push({ phone: phone, name: cName >= 0 ? String(v[i][cName] || '').trim() : '', route: route,
      sheetId: resolveRiderSheetId(sh, i + 1, cLink + 1, v[i][cLink], route) });
  }
  return out;
}
function buildSkuList(master) {
  var sh = findSheetByCols(master, SKU_TAB, [['sku_id', 'sku id', 'sku'], ['ean', 'barcode', 'sku_name', 'name', 'item name', 'product']]);
  if (!sh) return [];
  var v = sh.getDataRange().getValues(); var h = cols(v[0]);
  var cId = pick(h, ['sku_id', 'sku id', 'sku']);
  var cEan = pick(h, ['ean', 'barcode', 'ean code']);
  var cName = pick(h, ['sku_name', 'name', 'item name', 'product', 'description']);
  var out = [];
  for (var i = 1; i < v.length && cId >= 0; i++) {
    var id = String(v[i][cId] || '').trim(); if (!id) continue;
    out.push({ sku_id: id, ean: cEan >= 0 ? String(v[i][cEan] || '').trim() : '', sku_name: cName >= 0 ? String(v[i][cName] || '').trim() : '' });
  }
  return out;
}
function buildPpShopMap(master) {
  var map = {};
  master.getSheets().forEach(function (sh) {
    if (sh.getName() === ADMIN_TAB || sh.getName() === SKU_TAB) return;
    var v; try { v = sh.getDataRange().getValues(); } catch (_) { return; }
    if (!v.length) return;
    // Header may not be row 0 — route tabs have merged title rows above it. Scan the first rows.
    var hi = -1, cPP = -1, cShop = -1;
    for (var r = 0; r < Math.min(v.length, 12); r++) {
      var h = cols(v[r]);
      var p = pick(h, ['pp code', 'pp_code', 'source_hub', 'pp']);
      var s = pick(h, ['shop name', 'shop_name', 'shop', 'store name']);
      if (p >= 0 && s >= 0) { hi = r; cPP = p; cShop = s; break; }
    }
    if (hi < 0) return;
    for (var i = hi + 1; i < v.length; i++) { var pp = String(v[i][cPP] || '').trim(); if (pp && !map[pp]) map[pp] = String(v[i][cShop] || '').trim(); }
  });
  return map;
}

// ---- helpers ----------------------------------------------------------------
// Find a sheet by exact name, else the first whose header satisfies every column group.
function findSheetByCols(ss, preferredName, groups) {
  var byName = ss.getSheetByName(preferredName);
  if (byName) return byName;
  var sheets = ss.getSheets();
  for (var s = 0; s < sheets.length; s++) {
    var v; try { v = sheets[s].getDataRange().getValues(); } catch (_) { continue; }
    if (!v.length) continue;
    var h = cols(v[0]), ok = true;
    for (var g = 0; g < groups.length; g++) if (pick(h, groups[g]) < 0) { ok = false; break; }
    if (ok) return sheets[s];
  }
  return null;
}
function digits10(v) { var d = String(v == null ? '' : v).replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : d; }
function toInt(v) { var n = parseInt(String(v).replace(/[^\d-]/g, ''), 10); return isNaN(n) ? 0 : n; }
function cols(hr) { var m = {}; (hr || []).forEach(function (h, i) { m[String(h || '').trim().toLowerCase()] = i; }); return m; }
function pick(map, cand) {
  for (var c = 0; c < cand.length; c++) if (map[cand[c]] != null) return map[cand[c]];
  var keys = Object.keys(map);
  for (var c2 = 0; c2 < cand.length; c2++) for (var k = 0; k < keys.length; k++) if (keys[k].indexOf(cand[c2]) !== -1) return map[keys[k]];
  return -1;
}
function extractId(url) {
  if (!url) return '';
  var m = String(url).match(/\/d\/([a-zA-Z0-9_-]{20,})/); if (m) return m[1];
  m = String(url).match(/[?&]id=([a-zA-Z0-9_-]{20,})/); return m ? m[1] : '';
}
function resolveRiderSheetId(adminSheet, rowNum, colNum, cellVal, routeName) {
  try {
    var rt = adminSheet.getRange(rowNum, colNum).getRichTextValue();
    if (rt) { var u = rt.getLinkUrl(); if (!u) { var runs = rt.getRuns(); for (var i = 0; i < runs.length && !u; i++) u = runs[i].getLinkUrl(); } var id = extractId(u); if (id) return id; }
  } catch (_) {}
  try { var idf = extractId(adminSheet.getRange(rowNum, colNum).getFormula()); if (idf) return idf; } catch (_) {}
  var idc = extractId(cellVal); if (idc) return idc;
  var s = String(cellVal || '').trim();
  if (/^[a-zA-Z0-9_-]{20,}$/.test(s)) return s;
  var name = s || routeName;
  if (name) {
    try { var it = DriveApp.getFilesByName(name); if (it.hasNext()) return it.next().getId(); } catch (_) {}
    try { var it2 = DriveApp.searchFiles('title contains "' + name.replace(/"/g, '') + '" and mimeType = "application/vnd.google-apps.spreadsheet"'); if (it2.hasNext()) return it2.next().getId(); } catch (_) {}
  }
  return '';
}
function latestDateTab(ss) {
  // Prefer the newest YYYY-MM-DD tab (the intended daily-pending snapshot)…
  var best = null, bestName = '';
  ss.getSheets().forEach(function (sh) { var n = sh.getName().trim(); if (/^\d{4}-\d{2}-\d{2}$/.test(n) && n > bestName) { bestName = n; best = sh; } });
  if (best) return best;
  // …but until date tabs exist, fall back to the first sheet that looks like crate data.
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var v; try { v = sheets[i].getDataRange().getValues(); } catch (_) { continue; }
    if (!v.length) continue;
    var h = cols(v[0]);
    if (pick(h, ['crate_number', 'crate number', 'crate']) >= 0 && pick(h, ['source_hub', 'pp code', 'pp_code']) >= 0) return sheets[i];
  }
  return sheets[0] || null;
}
