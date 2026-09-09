import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'mm_reverse.db');
const SEED_CSV = process.env.SEED_CSV || path.join(__dirname, '..', 'seed', 'pp_pc_source.csv');

// Physical crate capacity in UNITS for now. Later becomes volume/weight-based per SKU
// (see logic.js unitLoad). Configurable via env.
export const DEFAULT_CRATE_CAPACITY = Number(process.env.CRATE_CAPACITY || 25);
// A crate not picked within created_date + this many days routes to asset clearance.
export const CLEARANCE_DAYS = Number(process.env.CLEARANCE_DAYS || 4);

// Until the real MM-rider→PP mapping is supplied, every PP is tagged to a single owner so
// one login sees all pending PPs. Override with RIDER_NAME / RIDER_PHONE env vars.
const OWNER = { name: process.env.RIDER_NAME || 'Amey', phone: process.env.RIDER_PHONE || '9999999999' };

// Eligibility "today": DEMO_DATE env pins it; otherwise the real clock. (Daily-fresh data
// keeps most crates in-window; older unpicked crates fall to asset clearance.)
const DEMO_DATE = process.env.DEMO_DATE;
export function today() { const d = DEMO_DATE ? new Date(DEMO_DATE + 'T00:00:00') : new Date(); d.setHours(0, 0, 0, 0); return d; }
export function isEligible(createdDate) {
  // Asset-clearance flow removed: every pending crate stays pickable (no +4-day staleness gate),
  // so nothing is silently hidden. Flip this back to the deadline check to re-enable clearance.
  return true;
}
export function clearanceDeadline(createdDate) {
  if (!createdDate) return null;
  const d = new Date(createdDate + 'T00:00:00'); d.setDate(d.getDate() + CLEARANCE_DAYS);
  return d.toISOString().slice(0, 10);
}

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

export function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

function createSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS source_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wh_date TEXT, pp_code TEXT, pc TEXT, crate_id TEXT, sku_id TEXT,
      created_at_source TEXT, dispatched_from_source TEXT, shipment_status TEXT, rto_qty INTEGER
    );

    CREATE TABLE IF NOT EXISTS pickup_points (
      pp_id INTEGER PRIMARY KEY AUTOINCREMENT,
      wh_date TEXT NOT NULL, pp_code TEXT NOT NULL, pp_cluster TEXT, pc TEXT, mm_rider TEXT NOT NULL, mm_rider_phone TEXT,
      stage TEXT NOT NULL DEFAULT 'PENDING',   -- PENDING, REACHED, RTO_CLOSED, EMPTY_CLOSED, LEFT
      reached_at TEXT, left_at TEXT,
      UNIQUE(pp_code)
    );

    CREATE TABLE IF NOT EXISTS crates (
      crate_id TEXT PRIMARY KEY,
      pp_id INTEGER NOT NULL, wh_date TEXT, pp_code TEXT, pc TEXT,
      type TEXT NOT NULL,                       -- 'RTO' | 'EMPTY'
      cumulative_rto INTEGER NOT NULL DEFAULT 0,
      created_date TEXT,
      capacity INTEGER,
      status TEXT NOT NULL DEFAULT 'CREATED',   -- CREATED, OPEN, CLOSED, SEALED, EMPTY_SCANNED, DISPATCHED, RECEIVED_AT_PC, CLEARED
      seal_id TEXT, closed_reason TEXT,
      opened_at TEXT, closed_at TEXT, sealed_at TEXT, dispatched_at TEXT, received_at_pc_at TEXT, cleared_at TEXT,
      FOREIGN KEY (pp_id) REFERENCES pickup_points(pp_id)
    );

    -- original per-crate RTO breakdown (for cumulative display + PP demand aggregation)
    CREATE TABLE IF NOT EXISTS crate_contents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      crate_id TEXT NOT NULL, pp_id INTEGER NOT NULL, sku_id TEXT NOT NULL, rto_qty INTEGER NOT NULL
    );

    -- RTO demand at PP level (rider consolidates across the PP's RTO crates)
    CREATE TABLE IF NOT EXISTS pp_rto_demand (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pp_id INTEGER NOT NULL, sku_id TEXT NOT NULL, sku_name TEXT, ean TEXT NOT NULL,
      expected_qty INTEGER NOT NULL, scanned_qty INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'OPEN', missing_qty INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (pp_id) REFERENCES pickup_points(pp_id)
    );

    CREATE TABLE IF NOT EXISTS scan_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      crate_id TEXT NOT NULL, pp_id INTEGER, sku_id TEXT, ean TEXT, rider TEXT, scanned_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS endstate_received_at_pc (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      crate_id TEXT NOT NULL UNIQUE, wh_date TEXT, pp_code TEXT, pp_cluster TEXT, pc TEXT, mm_rider TEXT,
      type TEXT, seal_id TEXT, total_units_scanned INTEGER,
      eligible_for_rps INTEGER NOT NULL DEFAULT 0, status TEXT, received_at TEXT NOT NULL
    );

    -- SKU master (sku_id -> real name + EAN), from the "EAN SKU Details" tab / uploaded workbook.
    -- Used for demand display, camera-EAN matching, and search-by-name/last-5-EAN.
    CREATE TABLE IF NOT EXISTS sku_catalog (
      sku_id TEXT PRIMARY KEY, sku_name TEXT, ean TEXT
    );
  `);
}

function parseCsv(text) {
  const rows = [];
  let field = '', row = [], inQuotes = false;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { if (row.length) { rows.push(row); row = []; } };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; } else field += c; }
    else if (c === '"') inQuotes = true;
    else if (c === ',') pushField();
    else if (c === '\r') { /* ignore */ }
    else if (c === '\n') { pushField(); pushRow(); }
    else field += c;
  }
  if (field.length || row.length) { pushField(); pushRow(); }
  return rows;
}

// Keep only PP-reverse crate rows — this is what "exclude FM RTO crates (never reached a PP)"
// means: FM rows have no PICKUP_POINT source_hub. Applied identically to CSV and Metabase rows.
const keepRow = (r) => r.flow_direction === 'REVERSE' && r.source_hub && r.crate_id;

// A raw row (from CSV or Metabase) is normalised to this shape; both feed the same pipeline.
export function csvRawRows() {
  if (!fs.existsSync(SEED_CSV)) { console.warn('[db] seed CSV not found at', SEED_CSV); return []; }
  const rows = parseCsv(fs.readFileSync(SEED_CSV, 'utf8'));
  const header = rows.shift();
  const idx = (name) => header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
  const C = {
    wh: idx('wh_processing_date'), sku: idx('sku_id'), status: idx('shipment_status'),
    crate: idx('crate_number'), src: idx('source_hub'), dst: idx('destination_hub'),
    flow: idx('flow_direction'), created: idx('created_at_source_timestamp'),
    dispatched: idx('dispatched_from_source_timestamp'), rto: idx('rto_qty'),
  };
  return rows.map((r) => ({
    wh_date: r[C.wh]?.trim(), flow_direction: r[C.flow]?.trim(), source_hub: r[C.src]?.trim(),
    pc: r[C.dst]?.trim(), crate_id: r[C.crate]?.trim(), sku_id: r[C.sku]?.trim() || null,
    created_at_source: r[C.created]?.trim() || null, dispatched_from_source: r[C.dispatched]?.trim() || null,
    shipment_status: r[C.status]?.trim() || null, rto_qty: Number(r[C.rto] || 0),
  }));
}

const pincodeOf = (ppCode) => (ppCode || '').split('-')[1] || ppCode;

// Dedup (latest wh_date per crate), pending filter, group → one entry per pending crate.
function computePending(rows) {
  rows = rows.filter(keepRow);
  const latest = new Map();
  for (const r of rows) { const c = latest.get(r.crate_id); if (!c || r.wh_date > c) latest.set(r.crate_id, r.wh_date); }
  const kept = rows.filter((r) => r.wh_date === latest.get(r.crate_id));
  const byCrate = new Map();
  for (const r of kept) { if (!byCrate.has(r.crate_id)) byCrate.set(r.crate_id, []); byCrate.get(r.crate_id).push(r); }
  const out = [];
  for (const [crate_id, rs] of byCrate) {
    const h = rs[0];
    if (!(h.created_at_source && !h.dispatched_from_source && h.shipment_status !== 'TERMINAL')) continue;
    const cumulative = rs.reduce((a, r) => a + (r.rto_qty || 0), 0);
    out.push({
      crate_id, pp_code: h.source_hub, pc: h.pc, wh_date: h.wh_date,
      created: (h.created_at_source || h.wh_date || '').slice(0, 10),
      type: cumulative > 0 ? 'RTO' : 'EMPTY', cumulative,
      contents: rs.filter((r) => r.sku_id && r.rto_qty > 0).map((r) => ({ sku_id: r.sku_id, rto_qty: r.rto_qty })),
    });
  }
  return out;
}

const ensurePP = (ppCode, pc, wh, rider = OWNER, shopName = null) => {
  const ex = db.prepare('SELECT pp_id FROM pickup_points WHERE pp_code=?').get(ppCode);
  if (ex) return ex.pp_id;
  // Show the shop name to the rider when we have it; fall back to PC · pincode.
  const cluster = shopName ? shopName : `PC ${pc || '—'} · ${pincodeOf(ppCode)}`;
  return Number(db.prepare(`INSERT INTO pickup_points (wh_date,pp_code,pp_cluster,pc,mm_rider,mm_rider_phone) VALUES (?,?,?,?,?,?)`)
    .run(wh, ppCode, cluster, pc, rider.name || OWNER.name, rider.phone || OWNER.phone).lastInsertRowid);
};

const insertCrate = (c, ppId) => {
  db.prepare(`INSERT OR IGNORE INTO crates (crate_id,pp_id,wh_date,pp_code,pc,type,cumulative_rto,created_date,capacity,status) VALUES (?,?,?,?,?,?,?,?,?, 'CREATED')`)
    .run(c.crate_id, ppId, c.wh_date, c.pp_code, c.pc, c.type, c.cumulative, c.created, DEFAULT_CRATE_CAPACITY);
  for (const s of c.contents) db.prepare(`INSERT INTO crate_contents (crate_id,pp_id,sku_id,rto_qty) VALUES (?,?,?,?)`).run(c.crate_id, ppId, s.sku_id, s.rto_qty);
};

// (Re)build pp_rto_demand for PENDING PPs only (they have zero scan progress, so it's safe to
// replace). In-progress PPs keep their live demand untouched. Stale RTO crates are excluded.
function recomputeDemandForPending() {
  const insDemand = db.prepare(`INSERT INTO pp_rto_demand (pp_id,sku_id,sku_name,ean,expected_qty) VALUES (?,?,?,?,?)`);
  const getSku = db.prepare('SELECT sku_name, ean FROM sku_catalog WHERE sku_id=?');
  for (const { pp_id } of db.prepare(`SELECT pp_id FROM pickup_points WHERE stage='PENDING'`).all()) {
    db.prepare('DELETE FROM pp_rto_demand WHERE pp_id=?').run(pp_id);
    const rows = db.prepare(`SELECT cc.sku_id, cc.rto_qty, c.created_date FROM crate_contents cc JOIN crates c ON c.crate_id=cc.crate_id WHERE cc.pp_id=? AND c.type='RTO'`).all(pp_id);
    const bySku = new Map();
    for (const r of rows) if (isEligible(r.created_date)) bySku.set(r.sku_id, (bySku.get(r.sku_id) || 0) + r.rto_qty);
    for (const [sku, qty] of bySku) {
      const m = getSku.get(sku) || {};
      // Real name/EAN from the catalog when present; else fall back to the sku_id as the scan code.
      insDemand.run(pp_id, sku, m.sku_name || `SKU ${sku}`, m.ean || sku, qty);
    }
  }
}

// Upsert the SKU master (sku_id -> name, ean). Safe to call repeatedly (each sync/upload).
export function upsertSkus(skus = []) {
  const up = db.prepare(`INSERT INTO sku_catalog (sku_id,sku_name,ean) VALUES (?,?,?)
    ON CONFLICT(sku_id) DO UPDATE SET sku_name=excluded.sku_name, ean=excluded.ean`);
  for (const s of skus) {
    const id = String(s.sku_id ?? '').trim();
    if (id) up.run(id, String(s.sku_name ?? '').trim() || null, String(s.ean ?? '').trim() || null);
  }
}

// Group already-pending rows (from the bridge or an uploaded workbook) into one entry per crate.
// No CSV-style pending filter here: the source is the rider's "pending as of today" tab, so every
// row counts. RTO crate if it has any rto_qty>0; otherwise an empty crate to return. FM included.
function cratesFromRows(rows) {
  const byCrate = new Map();
  for (const r of rows) {
    const crate_id = String(r.crate_id ?? r.crate_number ?? '').trim();
    if (!crate_id) continue;
    if (!byCrate.has(crate_id)) byCrate.set(crate_id, {
      crate_id,
      pp_code: String(r.pp_code ?? r.source_hub ?? '').trim(),
      pc: String(r.pc ?? r.dest_hub ?? r.destination_hub ?? '').trim() || null,
      shop_name: String(r.shop_name ?? '').trim() || null,
      rider: { name: String(r.rider_name ?? '').trim() || OWNER.name, phone: String(r.rider_phone ?? '').replace(/\D/g, '').slice(-10) || OWNER.phone },
      wh_date: String(r.wh_date ?? '').trim(),
      created: String(r.created ?? r.created_at ?? r.wh_date ?? '').slice(0, 10),
      skus: new Map(),
    });
    const c = byCrate.get(crate_id);
    const sku = String(r.sku_id ?? '').trim();
    const qty = Number(r.rto_qty || 0);
    if (sku && qty > 0) c.skus.set(sku, (c.skus.get(sku) || 0) + qty);
  }
  return [...byCrate.values()].map((c) => {
    const cumulative = [...c.skus.values()].reduce((a, q) => a + q, 0);
    return { ...c, type: cumulative > 0 ? 'RTO' : 'EMPTY', cumulative,
      contents: [...c.skus.entries()].map(([sku_id, rto_qty]) => ({ sku_id, rto_qty })) };
  });
}

// Ingest a day's pending crates (bridge push or workbook upload). Refreshes the PENDING set only:
// untouched pending PPs are replaced with the fresh data; any PP a rider has already started
// (REACHED/…/LEFT) and its crates are left completely alone, so a mid-shift sync never resets work.
export function ingest(payload = {}) {
  upsertSkus(payload.skus || []);
  const crates = cratesFromRows(payload.rows || []);
  let added = 0;
  tx(() => {
    const pend = db.prepare(`SELECT pp_id FROM pickup_points WHERE stage='PENDING'`).all().map((r) => r.pp_id);
    for (const id of pend) {
      db.prepare('DELETE FROM pp_rto_demand WHERE pp_id=?').run(id);
      db.prepare('DELETE FROM crate_contents WHERE pp_id=?').run(id);
      db.prepare('DELETE FROM scan_events WHERE pp_id=?').run(id);
      db.prepare('DELETE FROM crates WHERE pp_id=?').run(id);
    }
    if (pend.length) db.prepare(`DELETE FROM pickup_points WHERE stage='PENDING'`).run();
    for (const c of crates) {
      if (db.prepare('SELECT 1 FROM crates WHERE crate_id=?').get(c.crate_id)) continue; // owned by in-progress PP
      insertCrate(c, ensurePP(c.pp_code, c.pc, c.wh_date, c.rider, c.shop_name));
      added++;
    }
    recomputeDemandForPending();
  });
  logCounts(`ingested (+${added} crates, ${payload.rows?.length || 0} rows)`);
  return { added, rows: payload.rows?.length || 0, crates: crates.length };
}

function logCounts(verb) {
  const n = (q) => db.prepare(q).get().n;
  console.log(`[db] ${verb}: ${n('SELECT COUNT(*) n FROM pickup_points')} PPs, ${n('SELECT COUNT(*) n FROM crates')} crates (${n(`SELECT COUNT(*) n FROM crates WHERE type='RTO'`)} RTO)`);
}

// Full rebuild: wipe everything (incl. endstate) and load fresh. Startup + explicit full reset.
export function rebuild(rawRows) {
  tx(() => {
    for (const t of ['pp_rto_demand', 'crate_contents', 'crates', 'scan_events', 'endstate_received_at_pc', 'pickup_points', 'source_rows']) db.exec(`DELETE FROM ${t};`);
    for (const c of computePending(rawRows)) insertCrate(c, ensurePP(c.pp_code, c.pc, c.wh_date));
    recomputeDemandForPending();
  });
  logCounts('rebuilt');
}

// Additive merge: bring in newly-appeared pending crates without touching in-progress work,
// received-at-PC endstate, or any crate the app already owns. Safe for a live daily pull.
export function mergeNew(rawRows) {
  let added = 0;
  tx(() => {
    for (const c of computePending(rawRows)) {
      if (db.prepare('SELECT 1 FROM crates WHERE crate_id=?').get(c.crate_id)) continue;  // app already owns it
      insertCrate(c, ensurePP(c.pp_code, c.pc, c.wh_date));
      added++;
    }
    recomputeDemandForPending();
  });
  logCounts(`merged (+${added} new crates)`);
  return added;
}

export function validateCapacity() {
  const bad = db.prepare(
    `SELECT p.pp_code,
            COALESCE((SELECT SUM(expected_qty) FROM pp_rto_demand d WHERE d.pp_id=p.pp_id),0) units,
            COALESCE((SELECT COUNT(*) FROM crates c WHERE c.pp_id=p.pp_id AND c.type='RTO'),0) rto_crates,
            ${DEFAULT_CRATE_CAPACITY} cap
       FROM pickup_points p`
  ).all().filter((r) => r.units > r.rto_crates * r.cap);
  if (bad.length) {
    console.warn(`[db] ⚠ ${bad.length} PP(s) have more RTO units than their crates can hold:`);
    for (const b of bad) console.warn(`      ${b.pp_code}: ${b.units} units vs ${b.rto_crates}×${b.cap}`);
  }
  return bad;
}

export function initDb() {
  createSchema();
  // First boot with an empty DB: seed from the CSV fallback so the app is runnable offline.
  // A live Metabase pull (server startup / refresh endpoint) replaces or augments this.
  if (db.prepare('SELECT COUNT(*) n FROM pickup_points').get().n === 0) rebuild(csvRawRows());
  validateCapacity();
}
