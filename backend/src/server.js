import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initDb, DEFAULT_CRATE_CAPACITY, ingest } from './db.js';
import * as L from './logic.js';
import { parseWorkbook } from './parse.js';
import { pullAndLoad, metabaseConfigured, defaultWindow } from './metabase.js';
import { syncSheets, syncSheetsAsync, sheetsConfigured } from './sheets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
initDb();

// --- Admin gate: data downloads/ops are admin-only. Access = a Meesho email + an access code
// that the owner shares over mail to authorised @meesho.com people. Set ADMIN_ACCESS_CODE in
// env; if unset, one is generated at boot and printed so it can be shared. ---
const ADMIN_CODE = process.env.ADMIN_ACCESS_CODE || crypto.randomBytes(4).toString('hex');
const ADMIN_DOMAIN = (process.env.ADMIN_EMAIL_DOMAIN || '@meesho.com').toLowerCase();
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const requireAdmin = (req, res, next) => {
  if (req.get('x-admin-code') !== ADMIN_CODE) return res.status(401).json({ error: 'Admin access required', code: 'ADMIN_REQUIRED' });
  next();
};

// Shared token for the Apps Script bridge (sheet ⇄ app). Must match the TOKEN in the gateway script.
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || 'eeBcLyjyNomuc6EfH2WA99sqHc9K-JDO';
const requireBridge = (req, res, next) => {
  const t = req.get('x-bridge-token') || req.query.token || req.body?.token;
  if (t !== BRIDGE_TOKEN) return res.status(401).json({ error: 'bad bridge token', code: 'BAD_TOKEN' });
  next();
};

const app = express();
app.use(cors());
app.use(express.json({ limit: '30mb' }));   // room for a base64 workbook upload

const wrap = (fn) => (req, res) => {
  try {
    res.json(fn(req));
  } catch (e) {
    if (e instanceof L.ApiError) return res.status(e.status).json({ error: e.message, code: e.code, data: e.data });
    console.error(e);
    res.status(500).json({ error: 'Server error', code: 'INTERNAL' });
  }
};

const api = express.Router();

api.get('/health', (req, res) => res.json({ ok: true, capacity: DEFAULT_CRATE_CAPACITY }));

// ---- rider ----
api.get('/riders', wrap(() => ({ riders: L.riderRoster() })));          // placeholder roster (demo)
api.post('/login', wrap((req) => L.loginByPhone(req.body.phone)));      // login by contact number
api.get('/riders/:phone/pps', wrap((req) => ({ pps: L.riderPPs(req.params.phone) })));

api.get('/pps/:ppId', wrap((req) => L.ppView(Number(req.params.ppId))));
api.post('/pps/:ppId/reach', wrap((req) => L.reachPP(Number(req.params.ppId))));
api.post('/pps/:ppId/scan-rto-crate', wrap((req) => L.scanRtoCrate(Number(req.params.ppId), String(req.body.crateId || '').trim())));
api.post('/pps/:ppId/close-rto', wrap((req) => L.closeAllRto(Number(req.params.ppId))));
api.post('/pps/:ppId/scan-empty-crate', wrap((req) => L.scanEmptyCrate(Number(req.params.ppId), String(req.body.crateId || '').trim())));
api.post('/pps/:ppId/close-empty', wrap((req) => L.closeAllEmpty(Number(req.params.ppId))));
api.post('/pps/:ppId/leave', wrap((req) => L.leavePP(Number(req.params.ppId))));

// ---- crate scanning / consolidation ----
api.post('/crates/:crateId/scan-ean', wrap((req) => L.scanEan(req.params.crateId, String(req.body.skuId || '').trim(), req.body.ean, req.body.rider)));
api.post('/crates/:crateId/skus/:skuId/search-add', wrap((req) => L.searchAddUnit(req.params.crateId, req.params.skuId, req.body.query, req.body.rider)));
api.post('/pps/:ppId/demand/:skuId/close', wrap((req) => L.closeDemandSku(Number(req.params.ppId), req.params.skuId)));
api.post('/crates/:crateId/close', wrap((req) => L.closeCrate(req.params.crateId)));

// ---- PC receiver login (by contact number; scoped to that POC's PC) ----
api.get('/pc/roster', wrap(() => ({ pocs: L.pcRoster() })));
api.post('/pc/login', wrap((req) => {
  const s = L.pcLoginByPhone(req.body.phone);
  return { pc: s.pc, phone: s.phone, inbound: L.pcInbound(s.pc), endstate: L.pcEndstate(s.pc) };
}));

// ---- PC receive (crate scan only; scoped to the POC's PC) ----
api.get('/pc/inbound', wrap((req) => ({ crates: L.pcInbound(req.query.pc || null) })));
api.post('/pc/receive', (req, res) => {
  try {
    const r = L.pcReceive(String(req.body.crateId || '').trim(), req.body.crateId, req.body.pc || null);
    res.json(r);
    syncSheetsAsync();   // push updated Received + Rider-scan tabs to the GSheet (non-blocking)
  } catch (e) {
    if (e instanceof L.ApiError) return res.status(e.status).json({ error: e.message, code: e.code, data: e.data });
    console.error(e); res.status(500).json({ error: 'Server error', code: 'INTERNAL' });
  }
});
api.get('/pc/endstate', wrap((req) => ({ rows: L.pcEndstate(req.query.pc || null) })));
const sendCsv = (res, name, csv) => {
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}_${stamp}.csv"`);
  res.send(csv);
};
// data downloads are ADMIN-ONLY (require the shared access code)
api.get('/pc/endstate.csv', requireAdmin, (req, res) => { try { sendCsv(res, 'received_at_pc', L.pcEndstateCsv(req.query.pc || null)); } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); } });
api.get('/pc/rider-scans.csv', requireAdmin, (req, res) => { try { sendCsv(res, 'mm_rider_scans', L.riderScanCsv({ pc: req.query.pc || null })); } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); } });

// ---- asset clearance ----
api.get('/clearance', wrap(() => ({ crates: L.listClearance() })));
api.post('/clearance/:crateId/clear', wrap((req) => L.clearCrate(req.params.crateId)));

// ---- admin: login (Meesho email + shared access code), then data ops / downloads ----
api.post('/admin/login', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const code = String(req.body?.code || '');
  if (!email.endsWith(ADMIN_DOMAIN) || (ADMIN_EMAILS.length && !ADMIN_EMAILS.includes(email)))
    return res.status(403).json({ error: `Use your Meesho email (${ADMIN_DOMAIN})`, code: 'BAD_EMAIL' });
  if (code !== ADMIN_CODE) return res.status(403).json({ error: 'Invalid access code', code: 'BAD_CODE' });
  console.log(`[admin] ${email} authenticated`);
  res.json({ ok: true, email, metabase: metabaseConfigured(), sheets: sheetsConfigured() });
});
api.get('/admin/data-source', requireAdmin, (req, res) => res.json({ metabase: metabaseConfigured(), sheets: sheetsConfigured(), default_window: defaultWindow() }));
api.get('/admin/counts', requireAdmin, wrap(() => L.dataCounts()));
api.post('/admin/sync-sheets', requireAdmin, async (req, res) => {
  try {
    if (!sheetsConfigured()) return res.status(400).json({ error: 'Google Sheet not configured — set GOOGLE_SA_KEY_FILE (or GOOGLE_SA_CLIENT_EMAIL/GOOGLE_SA_PRIVATE_KEY) and GSHEET_ID', code: 'NO_SHEETS' });
    res.json({ ok: true, ...(await syncSheets()) });
  } catch (e) { console.error('[sheets]', e.message); res.status(502).json({ error: e.message, code: 'SHEETS_FAILED' }); }
});
api.post('/admin/refresh', requireAdmin, async (req, res) => {
  try {
    if (!metabaseConfigured()) return res.status(400).json({ error: 'Metabase not configured — set METABASE_API_KEY on the server', code: 'NO_METABASE_AUTH' });
    const { whStart, whEnd, mode } = req.body || {};
    const result = await pullAndLoad({ whStart, whEnd, mode: mode === 'rebuild' ? 'rebuild' : 'merge' });
    res.json({ ok: true, ...result });
  } catch (e) { console.error('[refresh]', e.message); res.status(502).json({ error: e.message, code: e.code || 'REFRESH_FAILED' }); }
});

// ---- data bridge (Apps Script pushes the day's pending crates in, pulls scan results out) ----
// Only inbound calls to Apps Script are blocked by the Meesho domain policy; outbound from Apps
// Script is free, so the sheet PUSHES to us here (token-gated) rather than us pulling from it.
api.post('/ingest', requireBridge, wrap((req) => ingest({ skus: req.body.skus, rows: req.body.rows })));
api.get('/scan-export', requireBridge, wrap(() => ({ cols: L.EXPORT_COLS, rows: L.scanExportRows() })));

// ---- admin: fallback data path — upload a workbook (xlsx/csv) of the rider sheets ----
api.post('/admin/upload', requireAdmin, wrap((req) => {
  const b64 = String(req.body?.data_base64 || '').replace(/^data:[^,]*,/, '');
  if (!b64) throw new L.ApiError(400, 'NO_FILE', 'No file provided');
  const parsed = parseWorkbook(Buffer.from(b64, 'base64'));
  const res = ingest({ skus: parsed.skus, rows: parsed.rows });
  return { ok: true, ...res, ...parsed.stats };
}));
// ---- admin: rider list + per-rider scan-data download ----
api.get('/admin/riders', requireAdmin, wrap(() => ({ riders: L.adminRiders() })));
api.get('/admin/scan-data.csv', requireAdmin, (req, res) => {
  try { sendCsv(res, `mm_rider_scans${req.query.phone ? '_' + req.query.phone : ''}`, L.riderScanCsv({ phone: req.query.phone || null })); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.use('/api', api);

// serve built frontend if present (single-image mode)
const clientDir = path.join(__dirname, '..', 'public');
if (fs.existsSync(clientDir)) {
  app.use(express.static(clientDir));
  app.get('*', (req, res) => res.sendFile(path.join(clientDir, 'index.html')));
}

const PORT = process.env.PORT || 8090;
app.listen(PORT, () => {
  console.log(`[server] MM Reverse API on http://localhost:${PORT}  (crate capacity=${DEFAULT_CRATE_CAPACITY} units)`);
  console.log(`[server] data source: ${metabaseConfigured() ? 'Metabase (auto-pull enabled)' : 'CSV seed (set METABASE_API_KEY to auto-pull)'}`);
  console.log(`[server] ADMIN ACCESS CODE: ${ADMIN_CODE}   (share over mail with ${ADMIN_DOMAIN} admins; set ADMIN_ACCESS_CODE to pin it)`);

  if (metabaseConfigured()) {
    // Pull once on boot (rebuild if the DB is only the CSV placeholder, else additive merge),
    // then keep it fresh on an interval so no one has to upload anything.
    const startupMode = process.env.STARTUP_PULL_MODE || 'merge';
    pullAndLoad({ mode: startupMode }).then((r) => console.log('[refresh] startup pull:', JSON.stringify(r)))
      .catch((e) => console.warn('[refresh] startup pull skipped:', e.message));

    const everyMin = Number(process.env.REFRESH_INTERVAL_MIN || 0);   // 0 = no interval; e.g. 1440 = daily
    if (everyMin > 0) {
      setInterval(() => pullAndLoad({ mode: 'merge' })
        .then((r) => console.log('[refresh] scheduled pull:', JSON.stringify(r)))
        .catch((e) => console.warn('[refresh] scheduled pull failed:', e.message)), everyMin * 60_000);
      console.log(`[server] auto-refresh every ${everyMin} min`);
    }
  }
});
