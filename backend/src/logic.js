import { db, tx, isEligible, clearanceDeadline } from './db.js';
export { isEligible };

export class ApiError extends Error {
  constructor(status, code, message, data) { super(message); this.status = status; this.code = code; this.data = data; }
}
const bad = (msg, code = 'INVALID', data) => { throw new ApiError(400, code, msg, data); };
const notFound = (msg) => { throw new ApiError(404, 'NOT_FOUND', msg); };
const nowIso = () => new Date().toISOString();

// ---- capacity (pluggable: today 1 unit = 1 load; later swap for volume/weight) ----
const unitLoad = () => 1;

// ---- readers ----
export const getPP = (ppId) => db.prepare('SELECT * FROM pickup_points WHERE pp_id=?').get(ppId);
export const getCrate = (crateId) => db.prepare('SELECT * FROM crates WHERE crate_id=?').get(crateId);
const crateLoad = (crateId) => db.prepare('SELECT COUNT(*) n FROM scan_events WHERE crate_id=?').get(crateId).n;
const ppDemand = (ppId) => db.prepare('SELECT * FROM pp_rto_demand WHERE pp_id=? ORDER BY id').all(ppId)
  .map((d) => ({ ...d, remaining: d.expected_qty - d.scanned_qty }));
const demandUnits = (ppId) => db.prepare('SELECT COALESCE(SUM(expected_qty),0) n FROM pp_rto_demand WHERE pp_id=?').get(ppId).n;
export const getActiveRtoCrate = (ppId) =>
  db.prepare(`SELECT * FROM crates WHERE pp_id=? AND type='RTO' AND status='OPEN'`).get(ppId);

function crateOut(c) {
  const load = crateLoad(c.crate_id);
  const eligible = isEligible(c.created_date);
  // an eligible EMPTY crate, or an eligible RTO crate the rider never scanned into, is
  // returned as an empty. A STALE crate is never returnable — it belongs to asset clearance.
  const empty_returnable = eligible && (c.type === 'EMPTY' || (c.type === 'RTO' && c.status === 'CREATED' && load === 0));
  return { ...c, load, empty_returnable, eligible, clearance_deadline: clearanceDeadline(c.created_date) };
}

// ---- rider login (by contact number) ----
const normPhone = (p) => String(p ?? '').replace(/\D/g, '').slice(-10);

// Placeholder roster for demo/testing until the real rider→number mapping is supplied.
export function riderRoster() {
  // Every rider stays listed; a rider who has left all their PPs is flagged done (shown greyed).
  return db.prepare(`SELECT mm_rider name, mm_rider_phone phone,
      COUNT(*) total_pps,
      COUNT(CASE WHEN stage!='LEFT' THEN 1 END) pps,
      CASE WHEN COUNT(CASE WHEN stage!='LEFT' THEN 1 END)=0 THEN 1 ELSE 0 END done
    FROM pickup_points GROUP BY mm_rider_phone
    ORDER BY done ASC, pps DESC`).all();
}

export function loginByPhone(phone) {
  const p = normPhone(phone);
  if (p.length !== 10) bad('Enter a valid 10-digit contact number', 'BAD_PHONE');
  const row = db.prepare(`SELECT mm_rider name, mm_rider_phone phone FROM pickup_points WHERE mm_rider_phone=? LIMIT 1`).get(p);
  if (!row) bad('No pickup points are assigned to this number', 'NO_RIDER');
  return { rider: row, pps: riderPPs(p) };
}

// ---- rider: PP list (by contact number) ----
export function riderPPs(phone) {
  const pps = db.prepare(`SELECT * FROM pickup_points WHERE mm_rider_phone=? AND stage!='LEFT' ORDER BY pp_code`).all(normPhone(phone));
  return pps.map((pp) => {
    const crates = db.prepare('SELECT * FROM crates WHERE pp_id=?').all(pp.pp_id);
    const eligible = crates.filter((c) => isEligible(c.created_date));
    return {
      pp_id: pp.pp_id, pp_code: pp.pp_code, pp_cluster: pp.pp_cluster, wh_date: pp.wh_date, stage: pp.stage,
      total_rto_units: demandUnits(pp.pp_id),
      rto_crates: eligible.filter((c) => c.type === 'RTO').length,
      empty_crates: eligible.filter((c) => c.type === 'EMPTY').length,
      stale_crates: crates.filter((c) => !isEligible(c.created_date) && c.status === 'CREATED').length,
    };
  }).sort((a, b) => b.total_rto_units - a.total_rto_units);
}

// ---- available actions (progressive disclosure, server-authoritative) ----
export function ppActions(pp) {
  const active = getActiveRtoCrate(pp.pp_id);
  if (pp.stage === 'PENDING') return [{ key: 'reach', label: 'Reached at PP', enabled: true }];
  if (pp.stage === 'LEFT') return [];
  if (active) {
    // While a crate is open, the only action is to keep scanning units into it.
    // Closing it (auto when full/all-packed, or manual) finalises it — no seal step.
    return [{ key: 'scan_ean', label: 'Scan EAN', enabled: true, active_crate: active.crate_id }];
  }
  if (pp.stage === 'REACHED') return [
    { key: 'scan_rto_crate', label: 'Scan RTO Crate', enabled: true },
    { key: 'close_all_rto', label: 'Close all RTO crates', enabled: true },
  ];
  if (pp.stage === 'RTO_CLOSED') return [
    { key: 'scan_empty_crate', label: 'Scan Empty Crate', enabled: true },
    { key: 'close_all_empty', label: 'Close all Empty Crates', enabled: true },
  ];
  if (pp.stage === 'EMPTY_CLOSED') return [{ key: 'leave', label: 'Left PP', enabled: true }];
  return [];
}

export function ppView(ppId) {
  const pp = getPP(ppId);
  if (!pp) notFound('Pickup point not found');
  const crates = db.prepare('SELECT * FROM crates WHERE pp_id=? ORDER BY type DESC, crate_id').all(ppId).map(crateOut);
  const active = getActiveRtoCrate(ppId);
  return {
    pp, actions: ppActions(pp), crates,
    demand: ppDemand(ppId),
    demand_units: demandUnits(ppId),
    packed_units: db.prepare('SELECT COUNT(*) n FROM scan_events WHERE pp_id=?').get(ppId).n,
    active_crate: active ? crateOut(active) : null,
  };
}

// ---- rider actions ----
export function reachPP(ppId) {
  const pp = getPP(ppId); if (!pp) notFound('Pickup point not found');
  if (pp.stage !== 'PENDING') bad('This PP has already been started', 'BAD_STAGE');
  // A PP with no RTO units to pick skips the RTO stage entirely → straight to empty crates.
  const stage = demandUnits(ppId) > 0 ? 'REACHED' : 'RTO_CLOSED';
  db.prepare(`UPDATE pickup_points SET stage=?, reached_at=? WHERE pp_id=?`).run(stage, nowIso(), ppId);
  return ppView(ppId);
}

export function scanRtoCrate(ppId, crateId) {
  const pp = getPP(ppId); if (!pp) notFound('Pickup point not found');
  if (pp.stage !== 'REACHED') bad('RTO scanning is not open for this PP', 'BAD_STAGE');
  if (getActiveRtoCrate(ppId)) bad('Finish the crate you already have open first', 'CRATE_ALREADY_OPEN');
  const crate = getCrate(crateId);
  if (!crate || crate.pp_id !== ppId) bad(`Crate ${crateId} does not belong to this PP`, 'WRONG_CRATE');
  if (crate.type !== 'RTO') bad(`${crateId} is an empty crate, not an RTO crate`, 'WRONG_TYPE');
  if (!isEligible(crate.created_date)) bad(`Crate ${crateId} is past its pickup window (created ${crate.created_date}). Route it to asset clearance.`, 'STALE_CRATE');
  if (crate.status !== 'CREATED') bad(`Crate ${crateId} has already been used`, 'ALREADY_PROCESSED');
  db.prepare(`UPDATE crates SET status='OPEN', opened_at=? WHERE crate_id=?`).run(nowIso(), crateId);
  return ppView(ppId);
}

// Resolve a code (exact EAN, last-≥3 of EAN, or a name fragment) against ALL of this PP's
// expected SKUs — used to identify the real SKU in hand and prevent wrong-SKU adds.
export function resolveDemand(ppId, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return [];
  const all = db.prepare('SELECT * FROM pp_rto_demand WHERE pp_id=?').all(ppId);
  let m = all.filter((d) => String(d.ean || '').toLowerCase() === q);              // exact EAN
  if (!m.length && q.length >= 3) m = all.filter((d) => String(d.ean || '').toLowerCase().endsWith(q)); // last-N of EAN
  if (!m.length) m = all.filter((d) => String(d.sku_name || '').toLowerCase().includes(q));             // name fragment
  return m;
}

// manual=true registers a unit without matching the EAN (used internally by search-add).
export function scanEan(crateId, skuId, ean, rider, manual = false) {
  const crate = getCrate(crateId); if (!crate) notFound('Crate not found');
  if (crate.status !== 'OPEN') bad('This crate is not open for scanning', 'CRATE_NOT_OPEN');
  const d = db.prepare('SELECT * FROM pp_rto_demand WHERE pp_id=? AND sku_id=?').get(crate.pp_id, skuId);
  if (!d) bad(`SKU ${skuId} is not expected at this PP`, 'WRONG_SKU');
  if (d.status !== 'OPEN') bad(`${d.sku_name} (${skuId}) is already closed`, 'SKU_CLOSED');
  const scanned = manual ? 'MANUAL' : String(ean ?? '').trim();
  if (!manual && scanned !== d.ean) {
    // identify which SKU this barcode actually belongs to, so the rider goes to the right one
    const other = db.prepare('SELECT * FROM pp_rto_demand WHERE pp_id=? AND lower(ean)=?').get(crate.pp_id, scanned.toLowerCase());
    if (other) bad(`That barcode is ${other.sku_name} (${other.sku_id}). Scan it under ${other.sku_name}, not ${d.sku_name}.`, 'WRONG_SKU_HERE', { sku_id: other.sku_id, sku_name: other.sku_name });
    bad(`Barcode ${scanned} is not a ${d.sku_name} unit, and isn't expected at this PP.`, 'FOREIGN_EAN');
  }
  if (d.scanned_qty >= d.expected_qty) bad('All units for this SKU are already scanned', 'SKU_FULL');
  const riderName = rider && typeof rider === 'object' ? (rider.name ?? null) : (rider ?? null);

  tx(() => {
    db.prepare('UPDATE pp_rto_demand SET scanned_qty=scanned_qty+1 WHERE id=?').run(d.id);
    db.prepare('INSERT INTO scan_events (crate_id,pp_id,sku_id,ean,rider,scanned_at) VALUES (?,?,?,?,?,?)')
      .run(crateId, crate.pp_id, skuId, scanned, riderName, nowIso());
  });

  const fresh = db.prepare('SELECT * FROM pp_rto_demand WHERE id=?').get(d.id);
  let skuDone = false;
  if (fresh.scanned_qty >= fresh.expected_qty) { db.prepare(`UPDATE pp_rto_demand SET status='CLOSED' WHERE id=?`).run(d.id); skuDone = true; }

  // capacity check (load vs crate capacity)
  let crateFull = false;
  const load = crateLoad(crateId);
  if (crate.capacity && load >= crate.capacity && crate.status === 'OPEN') {
    db.prepare(`UPDATE crates SET status='CLOSED', closed_reason='CAPACITY', closed_at=? WHERE crate_id=?`).run(nowIso(), crateId);
    crateFull = true;
  }

  // all PP demand packed?
  let demandDone = false;
  if (!crateFull) {
    const openLeft = db.prepare(`SELECT COUNT(*) n FROM pp_rto_demand WHERE pp_id=? AND status='OPEN'`).get(crate.pp_id).n;
    if (openLeft === 0) {
      db.prepare(`UPDATE crates SET status='CLOSED', closed_reason='DEMAND_DONE', closed_at=? WHERE crate_id=? AND status='OPEN'`).run(nowIso(), crateId);
      demandDone = true;
    }
  }

  let message = null;
  if (crateFull) message = 'This crate is full, please use a different crate for the rest of the units';
  else if (demandDone) message = 'All RTO units packed — crate closed automatically';
  else if (skuDone) message = `${d.sku_name} complete`;
  return { ...ppView(crate.pp_id), event: { sku_id: skuId, sku_done: skuDone, crate_full: crateFull, demand_done: demandDone, message, crate_id: crateId } };
}

// Search-validated add (scanner failed / tarnished EAN): the rider enters the in-hand item's
// name or last-5-of-EAN. We resolve it to the real SKU and ONLY add it if that SKU is the one
// they're in — otherwise we point them to the correct SKU instead of mis-assigning the unit.
export function searchAddUnit(crateId, currentSkuId, query, rider) {
  const crate = getCrate(crateId); if (!crate) notFound('Crate not found');
  if (crate.status !== 'OPEN') bad('This crate is not open for scanning', 'CRATE_NOT_OPEN');
  const matches = resolveDemand(crate.pp_id, query);
  if (!matches.length) bad(`No SKU at this PP matches “${query}”. Check the item / try the last 5 digits of its EAN.`, 'NOT_FOUND');
  if (matches.length > 1) bad(`“${query}” matches ${matches.length} SKUs — enter the last 5 digits of the EAN to be exact.`, 'AMBIGUOUS', { candidates: matches.map((m) => ({ sku_id: m.sku_id, sku_name: m.sku_name })) });
  const r = matches[0];
  if (r.sku_id !== currentSkuId)
    bad(`That item is ${r.sku_name} (${r.sku_id}) — add it under ${r.sku_name}, not this SKU.`, 'WRONG_SKU_HERE', { sku_id: r.sku_id, sku_name: r.sku_name, status: r.status });
  return scanEan(crateId, currentSkuId, r.ean, rider);   // identity confirmed → register the unit
}

// Scan-first unit capture (no SKU pre-selection). Resolve the scanned code to a KNOWN sku and
// count it: an expected sku counts down; a known-but-unexpected sku (older stock not in today's
// list, or an over-scan past the expected qty) is still accepted and counted; an unknown code is
// rejected as INVALID_SKU so the rider immediately sees it's wrong.
export function scanUnit(crateId, code, rider) {
  const crate = getCrate(crateId); if (!crate) notFound('Crate not found');
  if (crate.status !== 'OPEN') bad('Not accepted — this crate is already closed. Go back and scan a new RTO crate.', 'CRATE_NOT_OPEN');
  const q = String(code ?? '').trim();
  if (!q) bad('No barcode read — please scan again.', 'EMPTY');
  // resolve code → known sku (by EAN or sku_id): SKU catalog first, then this PP's demand rows
  const cat = db.prepare('SELECT sku_id, sku_name, ean FROM sku_catalog WHERE ean=? OR sku_id=?').get(q, q)
    || db.prepare('SELECT sku_id, sku_name, ean FROM pp_rto_demand WHERE pp_id=? AND (ean=? OR sku_id=?)').get(crate.pp_id, q, q);
  if (!cat) {
    // rejected — say exactly why so the rider can correct it
    if (db.prepare('SELECT 1 FROM crates WHERE crate_id=?').get(q))
      bad(`Not accepted — “${q}” is a crate barcode, not a product. Scan the item's own barcode.`, 'CRATE_NOT_PRODUCT');
    bad(`Not accepted — “${q}” isn't a known product (not in the system). Check you scanned the item's barcode, not the label/box.`, 'INVALID_SKU');
  }
  const skuId = cat.sku_id, skuName = cat.sku_name || `SKU ${skuId}`, ean = cat.ean || q;
  const riderName = rider && typeof rider === 'object' ? (rider.name ?? null) : (rider ?? null);

  tx(() => {
    const d = db.prepare('SELECT * FROM pp_rto_demand WHERE pp_id=? AND sku_id=?').get(crate.pp_id, skuId);
    if (d) db.prepare('UPDATE pp_rto_demand SET scanned_qty=scanned_qty+1 WHERE id=?').run(d.id);
    else db.prepare(`INSERT INTO pp_rto_demand (pp_id,sku_id,sku_name,ean,expected_qty,scanned_qty,status) VALUES (?,?,?,?,0,1,'OPEN')`).run(crate.pp_id, skuId, skuName, ean);
    db.prepare('INSERT INTO scan_events (crate_id,pp_id,sku_id,ean,rider,scanned_at) VALUES (?,?,?,?,?,?)').run(crateId, crate.pp_id, skuId, q, riderName, nowIso());
  });

  const fresh = db.prepare('SELECT * FROM pp_rto_demand WHERE pp_id=? AND sku_id=?').get(crate.pp_id, skuId);
  if (fresh.expected_qty > 0 && fresh.scanned_qty >= fresh.expected_qty && fresh.status === 'OPEN')
    db.prepare(`UPDATE pp_rto_demand SET status='CLOSED' WHERE id=?`).run(fresh.id);

  let crateFull = false;
  if (crate.capacity && crateLoad(crateId) >= crate.capacity && crate.status === 'OPEN') {
    db.prepare(`UPDATE crates SET status='CLOSED', closed_reason='CAPACITY', closed_at=? WHERE crate_id=?`).run(nowIso(), crateId);
    crateFull = true;
  }

  const remaining = Math.max(0, fresh.expected_qty - fresh.scanned_qty);
  const unexpected = fresh.expected_qty === 0;
  const over = fresh.expected_qty > 0 && fresh.scanned_qty > fresh.expected_qty;
  // ok = normal expected scan; warn = accepted-but-unusual (extra / over / crate full)
  const kind = (crateFull || unexpected || over) ? 'warn' : 'ok';
  const message = crateFull ? `Crate full — closed. Scan a new RTO crate for the rest.`
    : unexpected ? `Accepted, but heads-up: ${skuName} isn't in today's list for this PP (extra) — now ${fresh.scanned_qty} scanned.`
    : over ? `Accepted, but heads-up: ${skuName} was already complete — now ${fresh.scanned_qty}/${fresh.expected_qty} (extra).`
    : remaining > 0 ? `${skuName} · ${fresh.scanned_qty}/${fresh.expected_qty} — ${remaining} more to scan`
    : `${skuName} · ${fresh.scanned_qty}/${fresh.expected_qty} — done ✓`;
  return { ...ppView(crate.pp_id), event: { ok: true, kind, sku_id: skuId, sku_name: skuName, scanned: fresh.scanned_qty, expected: fresh.expected_qty, remaining, unexpected, over, crate_full: crateFull, message } };
}

// Live "find the item" search for when a barcode won't scan: match known SKUs by name, EAN
// (incl. last digits), or sku_id. Returns this PP's expected SKUs first. Tapping a result scans
// that SKU (scanUnit by sku_id), so the same expected/extra/over rules apply.
export function skuSearch(ppId, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (q.length < 2) return [];
  const like = '%' + q.replace(/[%_\\]/g, '') + '%';
  const catRows = db.prepare(`SELECT sku_id, sku_name, ean FROM sku_catalog WHERE lower(sku_name) LIKE ? OR lower(ean) LIKE ? OR lower(sku_id) LIKE ? LIMIT 50`).all(like, like, like);
  const demRows = db.prepare(`SELECT sku_id, sku_name, ean FROM pp_rto_demand WHERE pp_id=? AND (lower(sku_name) LIKE ? OR lower(ean) LIKE ? OR lower(sku_id) LIKE ?)`).all(ppId, like, like, like);
  const seen = new Set(); const out = [];
  for (const s of [...demRows, ...catRows]) {
    if (seen.has(s.sku_id)) continue; seen.add(s.sku_id);
    const d = db.prepare('SELECT expected_qty, scanned_qty FROM pp_rto_demand WHERE pp_id=? AND sku_id=?').get(ppId, s.sku_id);
    const expected = d ? d.expected_qty : 0, scanned = d ? d.scanned_qty : 0;
    out.push({ sku_id: s.sku_id, sku_name: s.sku_name || `SKU ${s.sku_id}`, ean: s.ean || '', expected_here: expected > 0, expected, scanned, remaining: Math.max(0, expected - scanned) });
  }
  out.sort((a, b) => (Number(b.expected_here) - Number(a.expected_here)) || String(a.sku_name).localeCompare(String(b.sku_name)));
  return out.slice(0, 12);
}

export function closeDemandSku(ppId, skuId) {
  const d = db.prepare('SELECT * FROM pp_rto_demand WHERE pp_id=? AND sku_id=?').get(ppId, skuId);
  if (!d) bad(`SKU ${skuId} is not expected at this PP`, 'WRONG_SKU');
  if (d.status !== 'OPEN') bad('SKU already closed', 'SKU_CLOSED');
  const missing = d.expected_qty - d.scanned_qty;
  db.prepare('UPDATE pp_rto_demand SET status=?, missing_qty=? WHERE id=?')
    .run(missing > 0 ? 'SHORT_CLOSED' : 'CLOSED', Math.max(0, missing), d.id);
  return { ...ppView(ppId), event: { sku_id: skuId, missing_qty: Math.max(0, missing) } };
}

export function closeCrate(crateId) {
  const crate = getCrate(crateId); if (!crate) notFound('Crate not found');
  if (crate.status !== 'OPEN') bad('Only an open crate can be closed', 'CRATE_NOT_OPEN');
  db.prepare(`UPDATE crates SET status='CLOSED', closed_reason='MANUAL', closed_at=? WHERE crate_id=?`).run(nowIso(), crateId);
  return ppView(crate.pp_id);
}

// Closing RTO is NOT allowed to silently drop shortfalls: if any expected unit is still unscanned,
// the rider must explicitly confirm marking those SKUs missing at the PP first. Unconfirmed, we
// return { needs_confirm:'missing', ... } so the UI can pop the question instead of closing.
export function closeAllRto(ppId, opts = {}) {
  const pp = getPP(ppId); if (!pp) notFound('Pickup point not found');
  if (pp.stage !== 'REACHED') bad('RTO crates are not open for this PP', 'BAD_STAGE');
  if (getActiveRtoCrate(ppId)) bad('Finish the open crate before closing all RTO crates', 'CRATE_OPEN');

  // Expected RTO units still not scanned (real shortfalls only — extras have expected_qty 0).
  const pendingSkus = db.prepare(
    `SELECT sku_id, sku_name, ean, expected_qty, scanned_qty, (expected_qty - scanned_qty) missing
       FROM pp_rto_demand WHERE pp_id=? AND status='OPEN' AND expected_qty > scanned_qty ORDER BY sku_name`
  ).all(ppId);

  if (pendingSkus.length > 0 && !opts.confirmMissing) {
    // Typically this fires when a crate filled at capacity and the rider pressed "Close all RTO
    // crates" instead of opening another crate for the rest. If a crate hit capacity, surface that
    // so the UI offers "Scan another RTO Crate" rather than "Go back to SKU Scanning".
    const crateFull = !!db.prepare(
      `SELECT 1 FROM crates WHERE pp_id=? AND type='RTO' AND closed_reason='CAPACITY' LIMIT 1`
    ).get(ppId);
    const pendingUnits = pendingSkus.reduce((a, s) => a + s.missing, 0);   // rto_qty − already scanned
    return { needs_confirm: 'missing', pending_skus: pendingSkus, pending_units: pendingUnits, crate_full: crateFull };
  }

  tx(() => {
    // Close every still-open SKU: a shortfall → SHORT_CLOSED + missing_qty, an extra → CLOSED.
    for (const s of db.prepare(`SELECT * FROM pp_rto_demand WHERE pp_id=? AND status='OPEN'`).all(ppId)) {
      const missing = s.expected_qty - s.scanned_qty;
      db.prepare(`UPDATE pp_rto_demand SET status=?, missing_qty=? WHERE id=?`).run(missing > 0 ? 'SHORT_CLOSED' : 'CLOSED', Math.max(0, missing), s.id);
    }
    db.prepare(`UPDATE pickup_points SET stage='RTO_CLOSED' WHERE pp_id=?`).run(ppId);
  });
  return ppView(ppId);
}

export function scanEmptyCrate(ppId, crateId) {
  const pp = getPP(ppId); if (!pp) notFound('Pickup point not found');
  if (pp.stage !== 'RTO_CLOSED') bad('Empty-crate scanning is not open yet', 'BAD_STAGE');
  const crate = getCrate(crateId);
  if (!crate || crate.pp_id !== ppId) bad(`Crate ${crateId} does not belong to this PP`, 'WRONG_CRATE');
  if (crate.status !== 'CREATED') bad(`Crate ${crateId} has already been scanned`, 'ALREADY_PROCESSED');
  // empty crates, or RTO crates the rider never packed into, are returned as empties
  if (crate.type === 'RTO' && crateLoad(crateId) > 0)
    bad(`${crateId} holds RTO units — seal it as an RTO crate instead`, 'WRONG_TYPE');
  if (!isEligible(crate.created_date)) bad(`Crate ${crateId} is past its pickup window. Route it to asset clearance.`, 'STALE_CRATE');
  db.prepare(`UPDATE crates SET status='EMPTY_SCANNED', closed_at=? WHERE crate_id=?`).run(nowIso(), crateId);
  return ppView(ppId);
}

// Closing the empty phase mirrors RTO: crates still shown in the empty list but not scanned must be
// intentionally marked unavailable at the PP (they count against "% of crates scanned"), never
// silently dropped. Unconfirmed, returns needs_confirm:'unavailable' with the pending crate list.
export function closeAllEmpty(ppId, opts = {}) {
  const pp = getPP(ppId); if (!pp) notFound('Pickup point not found');
  if (pp.stage !== 'RTO_CLOSED') bad('Empty crates are not open for this PP', 'BAD_STAGE');
  // Empty-returnable crates (empty crates + unpacked RTO crates) still CREATED = not scanned.
  const pendingCrates = db.prepare(
    `SELECT crate_id, type, created_date FROM crates WHERE pp_id=? AND status='CREATED' ORDER BY crate_id`
  ).all(ppId).filter((c) => isEligible(c.created_date) && (c.type === 'EMPTY' || crateLoad(c.crate_id) === 0));
  if (pendingCrates.length > 0 && !opts.confirmUnavailable)
    return { needs_confirm: 'unavailable', pending_crates: pendingCrates.map((c) => ({ crate_id: c.crate_id, type: c.type })) };
  tx(() => {
    for (const c of pendingCrates)
      db.prepare(`UPDATE crates SET status='UNAVAILABLE', closed_reason='UNAVAILABLE_AT_PP', closed_at=? WHERE crate_id=?`).run(nowIso(), c.crate_id);
    db.prepare(`UPDATE pickup_points SET stage='EMPTY_CLOSED' WHERE pp_id=?`).run(ppId);
  });
  return ppView(ppId);
}

export function leavePP(ppId) {
  const pp = getPP(ppId); if (!pp) notFound('Pickup point not found');
  if (pp.stage !== 'EMPTY_CLOSED') bad('Finish empty crates before leaving the PP', 'BAD_STAGE');
  const ts = nowIso();
  db.prepare(`UPDATE crates SET status='DISPATCHED', dispatched_at=? WHERE pp_id=? AND status IN ('CLOSED','EMPTY_SCANNED')`).run(ts, ppId);
  db.prepare(`UPDATE pickup_points SET stage='LEFT', left_at=? WHERE pp_id=?`).run(ts, ppId);
  return { left: true, pp_id: ppId };
}

// ---- PC receive ----
// ---- PC receiver login (by contact number; one POC per PC / destination hub) ----
const PC_POC_BASE = 8880000000;
export function pcRoster() {
  const pcs = db.prepare(`SELECT DISTINCT pc FROM crates WHERE pc IS NOT NULL AND pc<>'' ORDER BY pc`).all().map((r) => r.pc);
  return pcs.map((pc, i) => ({
    pc, phone: String(PC_POC_BASE + i + 1),
    inbound: db.prepare(`SELECT COUNT(*) n FROM crates WHERE status='DISPATCHED' AND pc=?`).get(pc).n,
  }));
}
export function pcLoginByPhone(phone) {
  const p = normPhone(phone);
  if (p.length !== 10) bad('Enter a valid 10-digit contact number', 'BAD_PHONE');
  const poc = pcRoster().find((r) => r.phone === p);
  if (!poc) bad('This number is not registered as a PC receiver', 'NO_POC');
  return { pc: poc.pc, phone: p };
}

// ---- PC receive: crate scan only. Individual units are NOT scanned here — that happens
// during reverse primary sorting. A POC only receives crates inbound to their own PC. ----
export function pcInbound(pc) {
  return db.prepare(
    `SELECT c.*, p.pp_cluster, p.mm_rider FROM crates c JOIN pickup_points p ON p.pp_id=c.pp_id
      WHERE c.status='DISPATCHED' AND (? IS NULL OR c.pc=?) ORDER BY c.pp_code, c.type DESC, c.crate_id`
  ).all(pc ?? null, pc ?? null).map((c) => {
    const units = crateLoad(c.crate_id);   // crates with packed units are RTO; the rest are empties
    return { crate_id: c.crate_id, pp_code: c.pp_code, pp_cluster: c.pp_cluster, mm_rider: c.mm_rider,
      pc: c.pc, wh_date: c.wh_date, type: units > 0 ? 'RTO' : 'EMPTY', units };
  });
}

export function pcReceive(crateId, scannedCrateId, pocPc) {
  const crate = getCrate(crateId); if (!crate) notFound('Crate not found');
  if (crate.status !== 'DISPATCHED') bad(`Crate ${crateId} is not inbound at the PC`, 'NOT_INBOUND');
  if (pocPc && crate.pc !== pocPc) bad(`Crate ${crateId} is inbound to ${crate.pc}, not your PC (${pocPc})`, 'WRONG_PC');
  if (scannedCrateId && String(scannedCrateId).trim() !== crateId) bad(`Scanned crate ${scannedCrateId} does not match ${crateId}`, 'CRATE_MISMATCH');
  const pp = getPP(crate.pp_id);
  const ts = nowIso();
  const units = crateLoad(crateId);
  const eligible = units > 0 ? 1 : 0;
  const status = units > 0 ? 'ELIGIBLE_FOR_RPS' : 'UNBLOCKED';
  tx(() => {
    db.prepare(`UPDATE crates SET status='RECEIVED_AT_PC', received_at_pc_at=? WHERE crate_id=?`).run(ts, crateId);
    db.prepare(`INSERT OR REPLACE INTO endstate_received_at_pc
      (crate_id,wh_date,pp_code,pp_cluster,pc,mm_rider,type,total_units_scanned,eligible_for_rps,status,received_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(crateId, crate.wh_date, crate.pp_code, pp.pp_cluster, crate.pc, pp.mm_rider, units > 0 ? 'RTO' : 'EMPTY', units, eligible, status, ts);
  });
  return { crate_id: crateId, type: units > 0 ? 'RTO' : 'EMPTY', status, eligible_for_rps: !!eligible, received_at: ts };
}

export function pcEndstate(pc) {
  return db.prepare(`SELECT * FROM endstate_received_at_pc WHERE (? IS NULL OR pc=?) ORDER BY received_at DESC`).all(pc ?? null, pc ?? null);
}

// SKU-wise "received at PC" rows — the handoff tech uses to mark Received at Destination and
// unblock for reverse primary sorting. One row per received crate × sku (units from rider scans).
export const RECEIVED_COLS = ['wh_date', 'source_hub', 'destination_hub', 'crate_number', 'mm_rider', 'sku_id', 'units_received', 'received_at', 'outcome'];
export function pcEndstateRows(pc) {
  const crates = db.prepare(`SELECT * FROM endstate_received_at_pc WHERE (? IS NULL OR pc=?) ORDER BY received_at, crate_id`).all(pc ?? null, pc ?? null);
  const rows = [];
  for (const c of crates) {
    const skus = db.prepare('SELECT sku_id, COUNT(*) units FROM scan_events WHERE crate_id=? GROUP BY sku_id ORDER BY sku_id').all(c.crate_id);
    if (skus.length) for (const s of skus) rows.push({ wh_date: c.wh_date, source_hub: c.pp_code, destination_hub: c.pc, crate_number: c.crate_id, mm_rider: c.mm_rider, sku_id: s.sku_id, units_received: s.units, received_at: c.received_at, outcome: c.status });
    else rows.push({ wh_date: c.wh_date, source_hub: c.pp_code, destination_hub: c.pc, crate_number: c.crate_id, mm_rider: c.mm_rider, sku_id: '', units_received: 0, received_at: c.received_at, outcome: c.status });
  }
  return rows;
}

const toCsv = (cols, rows) => {
  const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
};
export function pcEndstateCsv(pc) { return toCsv(RECEIVED_COLS, pcEndstateRows(pc)); }

// ---- MM rider scan data (crate-level: every crate the rider scanned, with unit count) ----
// One row per crate the rider actually scanned (moved past CREATED), so it shows WHICH crate
// was scanned and whether it carried units or was empty — even when no EANs were scanned.
export const SCAN_COLS = ['scanned_at', 'mm_rider', 'shop_name', 'source_hub', 'destination_hub', 'crate_number', 'crate_type', 'units_scanned', 'has_units', 'status', 'skus'];
// One row per crate the rider scanned. Filter by PC and/or rider phone (admin per-rider download).
export function riderScanRows({ pc = null, phone = null } = {}) {
  const ph = phone ? normPhone(phone) : null;
  const crates = db.prepare(
    `SELECT c.*, p.mm_rider, p.mm_rider_phone, p.pp_cluster FROM crates c JOIN pickup_points p ON p.pp_id=c.pp_id
      WHERE c.status NOT IN ('CREATED','CLEARED') AND (? IS NULL OR c.pc=?) AND (? IS NULL OR p.mm_rider_phone=?)
      ORDER BY COALESCE(c.opened_at, c.closed_at, c.dispatched_at, c.received_at_pc_at), c.crate_id`
  ).all(pc ?? null, pc ?? null, ph, ph);
  return crates.map((c) => {
    const skus = db.prepare('SELECT sku_id, COUNT(*) n FROM scan_events WHERE crate_id=? GROUP BY sku_id ORDER BY sku_id').all(c.crate_id);
    const units = skus.reduce((a, s) => a + s.n, 0);
    return {
      scanned_at: c.opened_at || c.closed_at || c.dispatched_at || c.received_at_pc_at || '',
      mm_rider: c.mm_rider, shop_name: c.pp_cluster, source_hub: c.pp_code, destination_hub: c.pc,
      crate_number: c.crate_id, crate_type: c.type, units_scanned: units,
      has_units: units > 0 ? 'Yes' : 'No', status: c.status,
      skus: skus.map((s) => `${s.sku_id}:${s.n}`).join('; '),
    };
  });
}
export function riderScanCsv(opts = {}) { return toCsv(SCAN_COLS, riderScanRows(opts)); }

// Riders known to the app (from the ingested/uploaded data), with progress counts — for the admin panel.
export function adminRiders() {
  return db.prepare(
    `SELECT p.mm_rider_phone phone, p.mm_rider name,
            COUNT(DISTINCT p.pp_id) pps,
            COUNT(DISTINCT CASE WHEN c.status NOT IN ('CREATED','CLEARED') THEN c.crate_id END) scanned_crates,
            COUNT(DISTINCT CASE WHEN p.stage='LEFT' THEN p.pp_id END) pps_done
       FROM pickup_points p LEFT JOIN crates c ON c.pp_id=p.pp_id
      GROUP BY p.mm_rider_phone, p.mm_rider ORDER BY p.mm_rider`
  ).all();
}

// Scan-data export for the Apps Script bridge. Two per-rider tabs (see the experiment template):
//   Format 1 = line-item, one row per scanned crate × SKU (values repeat across a crate's SKU rows).
//   Format 2 = one rollup row per assigned PP (the source for the % PPs / % crates / units metrics).
// A "scanned" crate moved past CREATED (opened/filled, or returned as an empty) and wasn't marked
// unavailable — unscanned (CREATED) and UNAVAILABLE crates both count against "% of crates scanned".
const SCANNED_CRATE = `status NOT IN ('CREATED','CLEARED','UNAVAILABLE')`;

// Timestamps are stored as UTC ISO; render them in IST (Asia/Kolkata) as 'yyyy-MM-dd HH:mm:ss' for the sheet.
const IST_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
function ist(v) {
  if (!v) return '';
  const d = new Date(v); if (isNaN(d.getTime())) return String(v);
  const p = {}; for (const x of IST_FMT.formatToParts(d)) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

export const SCAN_FORMATS = [
  { name: 'Scan Data Format 1', group_by: 'rider number', key: ['crate_id', 'sku_id'],
    cols: ['rider name', 'rider number', 'pp code', 'shop name', 'crate_id', 'crate type (Empty/RTO)', 'sku_id', 'sku_name', 'expected rto_qty', 'units_scanned', 'reached_at_pp_ts', 'crate_scan_ts', 'sku_first_scan_ts', 'sku_last_scan_ts', 'left_pp_ts'] },
  { name: 'Scan Data Format 2', group_by: 'rider number', key: ['pp code'],
    cols: ['rider name', 'rider number', 'pp code', 'rto_crates_qty', 'empty_crates_qty', 'rto_crates_scanned', 'empty_crates_scanned', 'expected_rto_qty', 'units_scanned', 'first_sku_scan_ts', 'last_sku_scan_ts', 'first_crate_scan_ts', 'last_crate_scan_ts', 'reached_at_pp_ts', 'left_pp_ts'] },
];

function scanFormat1Rows() {
  const crates = db.prepare(
    `SELECT c.*, p.mm_rider, p.mm_rider_phone, p.pp_cluster, p.reached_at, p.left_at
       FROM crates c JOIN pickup_points p ON p.pp_id=c.pp_id
      WHERE c.${SCANNED_CRATE} ORDER BY p.mm_rider_phone, c.crate_id`
  ).all();
  const rows = [];
  for (const c of crates) {
    const base = {
      'rider name': c.mm_rider, 'rider number': c.mm_rider_phone, 'pp code': c.pp_code, 'shop name': c.pp_cluster,
      'crate_id': c.crate_id, 'crate type (Empty/RTO)': c.type,
      'reached_at_pp_ts': ist(c.reached_at), 'crate_scan_ts': ist(c.opened_at || c.closed_at), 'left_pp_ts': ist(c.left_at),
    };
    const skus = db.prepare(
      `SELECT sku_id, COUNT(*) n, MIN(scanned_at) first_ts, MAX(scanned_at) last_ts
         FROM scan_events WHERE crate_id=? GROUP BY sku_id ORDER BY sku_id`
    ).all(c.crate_id);
    if (skus.length) {
      for (const s of skus) {
        const d = db.prepare('SELECT expected_qty, sku_name FROM pp_rto_demand WHERE pp_id=? AND sku_id=?').get(c.pp_id, s.sku_id) || {};
        const nm = d.sku_name || (db.prepare('SELECT sku_name FROM sku_catalog WHERE sku_id=?').get(s.sku_id) || {}).sku_name || '';
        rows.push({ ...base, 'sku_id': s.sku_id, 'sku_name': nm, 'expected rto_qty': d.expected_qty ?? '',
          'units_scanned': s.n, 'sku_first_scan_ts': ist(s.first_ts), 'sku_last_scan_ts': ist(s.last_ts) });
      }
    } else {
      rows.push({ ...base, 'sku_id': '', 'sku_name': '', 'expected rto_qty': c.type === 'EMPTY' ? '' : 0,
        'units_scanned': 0, 'sku_first_scan_ts': '', 'sku_last_scan_ts': '' });
    }
  }
  return rows;
}

function scanFormat2Rows() {
  const pps = db.prepare('SELECT * FROM pickup_points ORDER BY mm_rider_phone, pp_code').all();
  return pps.map((p) => {
    const cr = db.prepare(
      `SELECT
         SUM(CASE WHEN type='RTO' THEN 1 ELSE 0 END) rto_qty,
         SUM(CASE WHEN type='EMPTY' THEN 1 ELSE 0 END) empty_qty,
         SUM(CASE WHEN type='RTO' AND ${SCANNED_CRATE} THEN 1 ELSE 0 END) rto_scanned,
         SUM(CASE WHEN type='EMPTY' AND ${SCANNED_CRATE} THEN 1 ELSE 0 END) empty_scanned,
         MIN(CASE WHEN ${SCANNED_CRATE} THEN COALESCE(opened_at, closed_at) END) first_crate_ts,
         MAX(CASE WHEN ${SCANNED_CRATE} THEN COALESCE(opened_at, closed_at) END) last_crate_ts
       FROM crates WHERE pp_id=?`
    ).get(p.pp_id) || {};
    const ex = db.prepare('SELECT COALESCE(SUM(expected_qty),0) e FROM pp_rto_demand WHERE pp_id=?').get(p.pp_id).e;
    const su = db.prepare('SELECT COUNT(*) n, MIN(scanned_at) f, MAX(scanned_at) l FROM scan_events WHERE pp_id=?').get(p.pp_id);
    return {
      'rider name': p.mm_rider, 'rider number': p.mm_rider_phone, 'pp code': p.pp_code,
      'rto_crates_qty': cr.rto_qty || 0, 'empty_crates_qty': cr.empty_qty || 0,
      'rto_crates_scanned': cr.rto_scanned || 0, 'empty_crates_scanned': cr.empty_scanned || 0,
      'expected_rto_qty': ex, 'units_scanned': su.n || 0,
      'first_sku_scan_ts': ist(su.f), 'last_sku_scan_ts': ist(su.l),
      'first_crate_scan_ts': ist(cr.first_crate_ts), 'last_crate_scan_ts': ist(cr.last_crate_ts),
      'reached_at_pp_ts': ist(p.reached_at), 'left_pp_ts': ist(p.left_at),
    };
  });
}

// Payload the bridge pulls: each format carries its own header, upsert key and grouping field.
export function scanExportFormats() {
  return { formats: [
    { ...SCAN_FORMATS[0], rows: scanFormat1Rows() },
    { ...SCAN_FORMATS[1], rows: scanFormat2Rows() },
  ] };
}

// ---- ground-ops supervisor board: live per-rider progress + still-open PPs (read-only) ----
export function opsBoard() {
  const riders = db.prepare(
    `SELECT p.mm_rider_phone phone, p.mm_rider name,
       COUNT(DISTINCT p.pp_id) total_pps,
       COUNT(DISTINCT CASE WHEN p.stage='LEFT' THEN p.pp_id END) pps_done,
       COUNT(DISTINCT c.crate_id) total_crates,
       COUNT(DISTINCT CASE WHEN c.status='CREATED' THEN c.crate_id END) pending_crates,
       COUNT(DISTINCT CASE WHEN c.status='CREATED' AND c.type='RTO' THEN c.crate_id END) pending_rto_crates,
       COUNT(DISTINCT CASE WHEN c.status NOT IN ('CREATED','CLEARED') THEN c.crate_id END) done_crates
     FROM pickup_points p LEFT JOIN crates c ON c.pp_id=p.pp_id
     GROUP BY p.mm_rider_phone, p.mm_rider ORDER BY p.mm_rider`
  ).all();
  // last scan activity per rider (to flag who's idle / stalled)
  const last = {};
  for (const r of db.prepare(
    `SELECT p.mm_rider_phone phone, MAX(s.scanned_at) last_at
       FROM scan_events s JOIN pickup_points p ON p.pp_id=s.pp_id GROUP BY p.mm_rider_phone`
  ).all()) last[r.phone] = r.last_at;
  // still-open PPs (not yet left) per rider, with their pending-crate counts — the nudge list
  const ppRows = db.prepare(
    `SELECT p.mm_rider_phone phone, p.pp_code, p.pp_cluster, p.stage,
       COUNT(c.crate_id) total_crates,
       SUM(CASE WHEN c.status='CREATED' THEN 1 ELSE 0 END) pending_crates
     FROM pickup_points p LEFT JOIN crates c ON c.pp_id=p.pp_id
     WHERE p.stage!='LEFT' GROUP BY p.pp_id ORDER BY p.pp_code`
  ).all();
  const openByPhone = {};
  for (const pp of ppRows) (openByPhone[pp.phone] = openByPhone[pp.phone] || []).push({
    pp_code: pp.pp_code, cluster: pp.pp_cluster, stage: pp.stage, total_crates: pp.total_crates, pending_crates: pp.pending_crates || 0,
  });
  const sum = (f) => riders.reduce((a, r) => a + f(r), 0);
  return {
    generated_at: nowIso(),
    totals: { pending_pps: sum((r) => r.total_pps - r.pps_done), pending_crates: sum((r) => r.pending_crates), done_crates: sum((r) => r.done_crates) },
    riders: riders.map((r) => ({ ...r, pending_pps: r.total_pps - r.pps_done, last_activity: last[r.phone] || null, open_pps: openByPhone[r.phone] || [] })),
  };
}

// live counts for the admin panel
export function dataCounts() {
  const n = (q) => db.prepare(q).get().n;
  return {
    crates_scanned: n(`SELECT COUNT(*) n FROM crates WHERE status NOT IN ('CREATED','CLEARED')`),
    rider_scan_units: n('SELECT COUNT(*) n FROM scan_events'),
    received_crates: n('SELECT COUNT(*) n FROM endstate_received_at_pc'),
    received_rows: pcEndstateRows().length,
    pending_crates: n(`SELECT COUNT(*) n FROM crates WHERE status='CREATED'`),
    dispatched_crates: n(`SELECT COUNT(*) n FROM crates WHERE status='DISPATCHED'`),
  };
}

// ---- asset clearance: crates never picked past created_date + CLEARANCE_DAYS ----
export function listClearance() {
  return db.prepare(`SELECT c.*, p.mm_rider, p.pp_cluster FROM crates c JOIN pickup_points p ON p.pp_id=c.pp_id
    WHERE c.status IN ('CREATED','CLEARED') ORDER BY c.created_date`).all()
    .filter((c) => c.status === 'CLEARED' || !isEligible(c.created_date))
    .map((c) => ({
      crate_id: c.crate_id, pp_code: c.pp_code, pp_cluster: c.pp_cluster, mm_rider: c.mm_rider,
      type: c.type, created_date: c.created_date, deadline: clearanceDeadline(c.created_date),
      status: c.status, units: c.type === 'RTO' ? null : 0,
    }));
}
export function clearCrate(crateId) {
  const crate = getCrate(crateId); if (!crate) notFound('Crate not found');
  if (crate.status !== 'CREATED') bad(`Crate ${crateId} is not awaiting clearance`, 'BAD_STATE');
  if (isEligible(crate.created_date)) bad(`Crate ${crateId} is still within its pickup window`, 'STILL_ELIGIBLE');
  db.prepare(`UPDATE crates SET status='CLEARED', cleared_at=? WHERE crate_id=?`).run(nowIso(), crateId);
  return { crate_id: crateId, status: 'CLEARED' };
}
