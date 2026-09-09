/**
 * MM Reverse — Google Apps Script gateway (Sheets = the only data store).
 *
 * Deploy: open the MASTER sheet → Extensions → Apps Script → paste this file →
 *   Deploy → New deployment → type "Web app" → Execute as: Me →
 *   Who has access: Anyone → Deploy → copy the Web app URL.
 * Then set that URL as APPS_SCRIPT_URL and the TOKEN below as APPS_SCRIPT_TOKEN in Vercel.
 *
 * Actions (all require the shared token):
 *   GET  ?action=login&token=..&phone=..           -> that rider's latest-date pending crates (enriched)
 *   POST {action:'submit', token, phone, date, scans:[...]}  -> append to "Scan Data <date>" in the rider sheet
 *   GET  ?action=export&token=..&date=YYYY-MM-DD    -> all riders' Scan Data rows for a date (admin; proxy gates it)
 */

// ---- config -----------------------------------------------------------------
var TOKEN     = 'eeBcLyjyNomuc6EfH2WA99sqHc9K-JDO';  // must match APPS_SCRIPT_TOKEN in Vercel (change it if you like)
var MASTER_ID = '1zGfOjfPzVHzyMvx7oObkmyd-UUaEMWXjapIvxGVNyPQ';
var ADMIN_TAB = 'Admin Tab';      // rider directory
var SKU_TAB   = 'EAN SKU Details'; // sku_id <-> ean <-> name
var SCAN_TAB_PREFIX = 'Scan Data ';

// ---- router -----------------------------------------------------------------
function doGet(e)  { return route(e, (e && e.parameter) || {}); }
function doPost(e) {
  var body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (_) {}
  // let query params override for convenience
  var p = {}; for (var k in (e && e.parameter) || {}) p[k] = e.parameter[k];
  for (var j in body) p[j] = body[j];
  return route(e, p);
}

function route(e, p) {
  try {
    if (p.token !== TOKEN) return json({ ok: false, error: 'unauthorized' });
    switch (p.action) {
      case 'login':  return json(login(p.phone));
      case 'submit': return json(submit(p.phone, p.date, p.scans || []));
      case 'export': return json(exportScans(p.date));
      case 'ping':   return json({ ok: true, pong: true });
      default:       return json({ ok: false, error: 'unknown action: ' + p.action });
    }
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) });
  }
}

// ---- login ------------------------------------------------------------------
function login(phone) {
  var want = digits10(phone);
  if (!want) return { ok: false, error: 'phone required' };

  var master = SpreadsheetApp.openById(MASTER_ID);

  // 1) find rider in the Admin directory
  var admin = master.getSheetByName(ADMIN_TAB);
  if (!admin) return { ok: false, error: 'Admin tab "' + ADMIN_TAB + '" not found in master' };
  var av = admin.getDataRange().getValues();
  var ah = cols(av[0]);
  var cName  = pick(ah, ['rider name', 'name']);
  var cPhone = pick(ah, ['rider number', 'phone', 'number', 'contact']);
  var cRoute = pick(ah, ['route no', 'route', 'route no.']);
  var cLink  = pick(ah, ['sheet link', 'link', 'sheet']);
  if (cPhone < 0) return { ok: false, error: 'no phone column in Admin tab' };

  var rider = null, riderRowIdx = -1;
  for (var i = 1; i < av.length; i++) {
    if (digits10(av[i][cPhone]) === want) { rider = av[i]; riderRowIdx = i; break; }
  }
  if (!rider) return { ok: false, error: 'rider not found for this number' };

  var riderName = cName >= 0 ? String(rider[cName] || '').trim() : '';
  var route     = cRoute >= 0 ? String(rider[cRoute] || '').trim() : '';

  // 2) resolve the rider's own spreadsheet from the "Sheet link" cell (hyperlink or URL or name)
  var sheetId = resolveRiderSheetId(admin, riderRowIdx + 1, cLink + 1, rider[cLink], route);
  if (!sheetId) return { ok: false, error: 'could not resolve this rider\'s sheet from the master link' };
  var rss = SpreadsheetApp.openById(sheetId);

  // 3) latest date tab (YYYY-MM-DD)
  var dateTab = latestDateTab(rss);
  if (!dateTab) return { ok: false, error: 'no YYYY-MM-DD dated tab found in the rider sheet' };
  var date = dateTab.getName();

  // 4) lookups: SKU (id -> name, ean) + PP shop names
  var skuMap = buildSkuMap(master);
  var ppMap  = buildPpShopMap(master);

  // 5) read the day's rows
  var dv = dateTab.getDataRange().getValues();
  var dh = cols(dv[0]);
  var cCrate = pick(dh, ['crate_number', 'crate number', 'crate']);
  var cSku   = pick(dh, ['sku_id', 'sku id', 'sku']);
  var cPP    = pick(dh, ['source_hub', 'pp code', 'pp_code', 'source hub']);
  var cDest  = pick(dh, ['destination_hub', 'destination hub', 'pc']);
  var cRto   = pick(dh, ['rto_qty', 'rto qty', 'rto']);
  var cFlag  = pick(dh, ['rto_flag', 'rto flag']);
  var cFlow  = pick(dh, ['flow_direction', 'flow direction', 'flow']);
  var cCreat = pick(dh, ['created_at_source_timestamp', 'created_at', 'created at']);
  var cWh    = pick(dh, ['wh_processing_date', 'wh date', 'wh_date']);

  var rows = [];
  for (var r = 1; r < dv.length; r++) {
    var row = dv[r];
    var crate = cCrate >= 0 ? String(row[cCrate] || '').trim() : '';
    if (!crate) continue; // skip blanks
    var skuId = cSku >= 0 ? String(row[cSku] || '').trim() : '';
    var pp    = cPP  >= 0 ? String(row[cPP]  || '').trim() : '';
    var meta  = skuMap[skuId] || {};
    rows.push({
      wh_date:    cWh    >= 0 ? String(row[cWh]    || '') : '',
      pp_code:    pp,
      shop_name:  ppMap[pp] || '',
      dest_hub:   cDest  >= 0 ? String(row[cDest]  || '') : '',
      crate_number: crate,
      sku_id:     skuId,
      sku_name:   meta.name || '',
      ean:        meta.ean  || '',
      rto_qty:    cRto   >= 0 ? toInt(row[cRto]) : 0,
      rto_flag:   cFlag  >= 0 ? String(row[cFlag]  || '') : '',
      flow:       cFlow  >= 0 ? String(row[cFlow]  || '') : '',
      created_at: cCreat >= 0 ? String(row[cCreat] || '') : ''
    });
  }

  return {
    ok: true,
    rider: { name: riderName, phone: want, route: route, sheetId: sheetId, date: date },
    rows: rows
  };
}

// ---- submit -----------------------------------------------------------------
// scans: [{pp_code, shop_name, crate_number, sku_id, sku_name, expected_rto, units_scanned, status, scanned_at_pp}]
function submit(phone, date, scans) {
  var want = digits10(phone);
  if (!want) return { ok: false, error: 'phone required' };
  if (!date) return { ok: false, error: 'date required' };
  if (!scans.length) return { ok: true, appended: 0 };

  var master = SpreadsheetApp.openById(MASTER_ID);
  var admin = master.getSheetByName(ADMIN_TAB);
  var av = admin.getDataRange().getValues();
  var ah = cols(av[0]);
  var cPhone = pick(ah, ['rider number', 'phone', 'number', 'contact']);
  var cRoute = pick(ah, ['route no', 'route', 'route no.']);
  var cName  = pick(ah, ['rider name', 'name']);
  var cLink  = pick(ah, ['sheet link', 'link', 'sheet']);

  var riderRowIdx = -1, route = '', riderName = '';
  for (var i = 1; i < av.length; i++) {
    if (digits10(av[i][cPhone]) === want) {
      riderRowIdx = i;
      route = cRoute >= 0 ? String(av[i][cRoute] || '').trim() : '';
      riderName = cName >= 0 ? String(av[i][cName] || '').trim() : '';
      break;
    }
  }
  if (riderRowIdx < 0) return { ok: false, error: 'rider not found' };

  var sheetId = resolveRiderSheetId(admin, riderRowIdx + 1, cLink + 1, av[riderRowIdx][cLink], route);
  var rss = SpreadsheetApp.openById(sheetId);

  var tabName = SCAN_TAB_PREFIX + date;
  var tab = rss.getSheetByName(tabName);
  var header = ['scanned_at_pp', 'rider', 'route', 'pp_code', 'shop_name', 'crate_number',
                'sku_id', 'sku_name', 'expected_rto', 'units_scanned', 'status'];
  if (!tab) { tab = rss.insertSheet(tabName); tab.appendRow(header); tab.setFrozenRows(1); }

  var out = scans.map(function (s) {
    return [
      s.scanned_at_pp || new Date().toISOString(),
      riderName, route,
      s.pp_code || '', s.shop_name || '', s.crate_number || '',
      s.sku_id || '', s.sku_name || '',
      s.expected_rto == null ? '' : s.expected_rto,
      s.units_scanned == null ? '' : s.units_scanned,
      s.status || ''
    ];
  });
  tab.getRange(tab.getLastRow() + 1, 1, out.length, header.length).setValues(out);
  return { ok: true, appended: out.length, tab: tabName, sheetId: sheetId };
}

// ---- export (admin; the Vercel proxy enforces the admin gate) ---------------
function exportScans(date) {
  if (!date) return { ok: false, error: 'date required' };
  var master = SpreadsheetApp.openById(MASTER_ID);
  var admin = master.getSheetByName(ADMIN_TAB);
  var av = admin.getDataRange().getValues();
  var ah = cols(av[0]);
  var cPhone = pick(ah, ['rider number', 'phone', 'number', 'contact']);
  var cRoute = pick(ah, ['route no', 'route', 'route no.']);
  var cLink  = pick(ah, ['sheet link', 'link', 'sheet']);
  var tabName = SCAN_TAB_PREFIX + date;

  var all = [];
  for (var i = 1; i < av.length; i++) {
    if (!digits10(av[i][cPhone])) continue;
    var route = cRoute >= 0 ? String(av[i][cRoute] || '').trim() : '';
    var id = resolveRiderSheetId(admin, i + 1, cLink + 1, av[i][cLink], route);
    if (!id) continue;
    var tab;
    try { tab = SpreadsheetApp.openById(id).getSheetByName(tabName); } catch (_) { continue; }
    if (!tab || tab.getLastRow() < 2) continue;
    var v = tab.getDataRange().getValues();
    for (var r = 1; r < v.length; r++) all.push(v[r]);
    if (!all.headerSet) { all.header = v[0]; all.headerSet = true; }
  }
  return { ok: true, date: date, header: all.header || [], rows: all };
}

// ---- helpers ----------------------------------------------------------------
function json(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
function digits10(v) {
  var d = String(v == null ? '' : v).replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : d; // last 10 digits (drops +91 / leading 0)
}
function toInt(v) { var n = parseInt(String(v).replace(/[^\d-]/g, ''), 10); return isNaN(n) ? 0 : n; }
function cols(headerRow) {
  var m = {};
  (headerRow || []).forEach(function (h, i) { m[String(h || '').trim().toLowerCase()] = i; });
  return m;
}
// exact match first, then "contains" on the candidate
function pick(map, candidates) {
  for (var c = 0; c < candidates.length; c++) if (map[candidates[c]] != null) return map[candidates[c]];
  var keys = Object.keys(map);
  for (var c2 = 0; c2 < candidates.length; c2++)
    for (var k = 0; k < keys.length; k++)
      if (keys[k].indexOf(candidates[c2]) !== -1) return map[keys[k]];
  return -1;
}

function extractId(url) {
  if (!url) return '';
  var m = String(url).match(/\/d\/([a-zA-Z0-9_-]{20,})/);
  if (m) return m[1];
  m = String(url).match(/[?&]id=([a-zA-Z0-9_-]{20,})/);
  return m ? m[1] : '';
}
// Resolve the rider spreadsheet id from the "Sheet link" cell: hyperlink -> URL text -> Drive-by-name.
function resolveRiderSheetId(adminSheet, rowNum, colNum, cellVal, routeName) {
  // (a) rich-text hyperlink
  try {
    var rt = adminSheet.getRange(rowNum, colNum).getRichTextValue();
    if (rt) {
      var u = rt.getLinkUrl();
      if (!u) { var runs = rt.getRuns(); for (var i = 0; i < runs.length && !u; i++) u = runs[i].getLinkUrl(); }
      var id = extractId(u); if (id) return id;
    }
  } catch (_) {}
  // (b) =HYPERLINK formula or a raw URL/id in the cell
  try {
    var f = adminSheet.getRange(rowNum, colNum).getFormula();
    var idf = extractId(f); if (idf) return idf;
  } catch (_) {}
  var idc = extractId(cellVal); if (idc) return idc;
  var s = String(cellVal || '').trim();
  if (/^[a-zA-Z0-9_-]{20,}$/.test(s)) return s; // bare id
  // (c) find a spreadsheet in Drive named like the route / cell text
  var name = s || routeName;
  if (name) {
    try {
      var it = DriveApp.getFilesByName(name);
      if (it.hasNext()) return it.next().getId();
    } catch (_) {}
    try {
      var it2 = DriveApp.searchFiles('title contains "' + name.replace(/"/g, '') +
        '" and mimeType = "application/vnd.google-apps.spreadsheet"');
      if (it2.hasNext()) return it2.next().getId();
    } catch (_) {}
  }
  return '';
}

function latestDateTab(ss) {
  var best = null, bestName = '';
  ss.getSheets().forEach(function (sh) {
    var n = sh.getName().trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(n) && n > bestName) { bestName = n; best = sh; }
  });
  return best;
}

function buildSkuMap(master) {
  var map = {};
  var sh = master.getSheetByName(SKU_TAB);
  if (!sh) return map;
  var v = sh.getDataRange().getValues();
  var h = cols(v[0]);
  var cId   = pick(h, ['sku_id', 'sku id', 'sku']);
  var cEan  = pick(h, ['ean', 'barcode', 'ean code']);
  var cName = pick(h, ['sku_name', 'name', 'item name', 'product', 'description']);
  if (cId < 0) return map;
  for (var i = 1; i < v.length; i++) {
    var id = String(v[i][cId] || '').trim();
    if (!id) continue;
    map[id] = {
      ean:  cEan  >= 0 ? String(v[i][cEan]  || '').trim() : '',
      name: cName >= 0 ? String(v[i][cName] || '').trim() : ''
    };
  }
  return map;
}

// PP code -> shop name, gathered from every route tab that has both columns.
function buildPpShopMap(master) {
  var map = {};
  master.getSheets().forEach(function (sh) {
    if (sh.getName() === ADMIN_TAB || sh.getName() === SKU_TAB) return;
    var v; try { v = sh.getDataRange().getValues(); } catch (_) { return; }
    if (!v.length) return;
    var h = cols(v[0]);
    var cPP   = pick(h, ['pp code', 'pp_code', 'source_hub', 'pp']);
    var cShop = pick(h, ['shop name', 'shop_name', 'shop', 'store name', 'owner name']);
    if (cPP < 0 || cShop < 0) return;
    for (var i = 1; i < v.length; i++) {
      var pp = String(v[i][cPP] || '').trim();
      if (pp && !map[pp]) map[pp] = String(v[i][cShop] || '').trim();
    }
  });
  return map;
}
