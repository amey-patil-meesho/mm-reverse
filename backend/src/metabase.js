import { rebuild, mergeNew } from './db.js';

// Pulls the reverse-crate query straight from Metabase so no one has to download/upload a CSV.
// Auth + host come from env; the secret is never hard-coded. The query's output columns are
// identical to the CSV, so rows feed the exact same pipeline (dedup, pending filter, FM excluded).
const BASE = (process.env.METABASE_URL || 'https://metabase-main.bi.meeshogcp.in').replace(/\/+$/, '');
const CARD = process.env.METABASE_CARD_ID || '190711';   // saved card behind the shared question URL

function authHeaders() {
  if (process.env.METABASE_API_KEY) return { 'x-api-key': process.env.METABASE_API_KEY };
  if (process.env.METABASE_SESSION) return { 'X-Metabase-Session': process.env.METABASE_SESSION };
  const e = new Error('Metabase not configured — set METABASE_API_KEY (or METABASE_SESSION)');
  e.code = 'NO_METABASE_AUTH';
  throw e;
}
export const metabaseConfigured = () => !!(process.env.METABASE_API_KEY || process.env.METABASE_SESSION);

export function defaultWindow(days = Number(process.env.REFRESH_DAYS || 7)) {
  const fmt = (d) => d.toISOString().slice(0, 10);
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days);
  return { whStart: fmt(start), whEnd: fmt(end) };
}

const norm = (v) => (v == null ? null : (String(v).trim() || null));

// Run the saved card for a wh_date window and normalise rows into the shared raw-row shape.
export async function fetchReverseRows(whStart, whEnd) {
  const parameters = [
    { type: 'date/single', target: ['variable', ['template-tag', 'wh_date_start']], value: whStart },
    { type: 'date/single', target: ['variable', ['template-tag', 'wh_date_end']], value: whEnd },
  ];
  const res = await fetch(`${BASE}/api/card/${CARD}/query/json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ parameters }),
  });
  if (!res.ok) throw new Error(`Metabase pull failed: HTTP ${res.status} — ${(await res.text()).slice(0, 300)}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error('Metabase returned an unexpected payload (expected a JSON array of rows)');
  return rows.map((r) => ({
    wh_date: r.wh_processing_date ? String(r.wh_processing_date).slice(0, 10) : null,
    flow_direction: norm(r.flow_direction),
    source_hub: norm(r.source_hub),
    pc: norm(r.destination_hub),
    crate_id: norm(r.crate_number),
    sku_id: r.sku_id == null ? null : String(r.sku_id).trim(),
    created_at_source: norm(r.created_at_source_timestamp),
    dispatched_from_source: norm(r.dispatched_from_source_timestamp),
    shipment_status: norm(r.shipment_status),
    rto_qty: Number(r.rto_qty || 0),
  }));
}

// Pull + load. mode 'merge' (default) is additive and safe for a live daily refresh;
// 'rebuild' wipes and reloads (initial load / full reset).
export async function pullAndLoad({ whStart, whEnd, mode = 'merge' } = {}) {
  const w = whStart && whEnd ? { whStart, whEnd } : defaultWindow();
  const rows = await fetchReverseRows(w.whStart, w.whEnd);
  const added = mode === 'rebuild' ? (rebuild(rows), null) : mergeNew(rows);
  return { window: w, mode, fetched: rows.length, added };
}
