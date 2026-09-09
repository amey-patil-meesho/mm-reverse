import React, { useState } from 'react';
import { api } from './api.js';
import { TopBar, Note, Modal, ScanInput } from './ui.jsx';

const STAGE_LABEL = { PENDING: 'Pending', REACHED: 'At PP · RTO', RTO_CLOSED: 'At PP · Empty', EMPTY_CLOSED: 'Ready to leave' };
const CRATE_BADGE = {
  CREATED: ['grey', 'Available'], OPEN: ['amber', 'Filling'], CLOSED: ['green', 'Closed · ready'],
  EMPTY_SCANNED: ['green', 'Scanned'], DISPATCHED: ['blue', 'Dispatched'],
  RECEIVED_AT_PC: ['blue', 'At PC'], CLEARED: ['grey', 'Cleared'],
};
const SKU_BADGE = { OPEN: ['grey', 'Open'], CLOSED: ['green', 'Done'], SHORT_CLOSED: ['amber', 'Short'] };

export default function RiderFlow() {
  const [view, setView] = useState('login');
  const [rider, setRider] = useState(null);   // { name, phone }
  const [roster, setRoster] = useState([]);    // placeholder logins (demo hint)
  const [phone, setPhone] = useState('');
  const [skuSearch, setSkuSearch] = useState('');   // in-SKU identify: name / last-5 of EAN
  const [redirect, setRedirect] = useState(null);   // { sku_id, sku_name } when item belongs to another SKU
  const [pps, setPps] = useState([]);
  const [pv, setPv] = useState(null);       // full PP view (single source of truth)
  const [skuId, setSkuId] = useState(null);
  const [msg, setMsg] = useState(null);
  const [modal, setModal] = useState(null);

  const flash = (kind, text) => setMsg({ kind, text });
  const clearMsg = () => setMsg(null);
  const guard = (fn) => async (...a) => { try { clearMsg(); await fn(...a); } catch (e) { flash('err', e.message); } };

  React.useEffect(() => { api.riders().then((r) => setRoster(r.riders)).catch(() => {}); }, []);

  const login = guard(async (num) => { const res = await api.login(num ?? phone); setRider(res.rider); setPps(res.pps); setView('pps'); });
  const refreshPPs = async () => setPps((await api.riderPPs(rider.phone)).pps);
  const openPP = guard(async (ppId) => { setPv(await api.pp(ppId)); setView('pp'); });

  const activeCrateId = () => pv?.active_crate?.crate_id;

  const doAction = guard(async (key) => {
    const ppId = pv.pp.pp_id;
    if (key === 'reach') return setPv(await api.reach(ppId));
    if (key === 'close_all_rto') { setPv(await api.closeRto(ppId)); return flash('ok', 'All RTO crates closed'); }
    if (key === 'close_all_empty') { setPv(await api.closeEmpty(ppId)); return flash('ok', 'All empty crates closed'); }
    if (key === 'leave') { await api.leave(ppId); await refreshPPs(); setView('pps'); return flash('ok', `${pv.pp.pp_code} closed`); }
    if (key === 'scan_ean') return setView('crate');
    if (key === 'scan_rto_crate') {
      return setModal({ type: 'crate', title: 'Scan RTO Crate', hint: 'Scan an available crate to consolidate RTO units into.',
        onScan: guard(async (id) => { setPv(await api.scanRtoCrate(ppId, id)); setModal(null); setView('crate'); }) });
    }
    if (key === 'scan_empty_crate') {
      return setModal({ type: 'crate', title: 'Scan Empty Crate', hint: 'Empty crates do not need sealing.',
        onScan: guard(async (id) => { setPv(await api.scanEmptyCrate(ppId, id)); setModal(null); flash('ok', `Empty crate ${id} scanned`); }) });
    }
  });

  // ---------- screens ----------
  if (view === 'login') return (
    <>
      <TopBar title="MM Reverse" sub="Rider login" />
      <div className="wrap">
        {msg && <Note kind={msg.kind}>{msg.text}</Note>}
        <div className="card">
          <div className="small muted" style={{ marginBottom: 6 }}>Enter your registered contact number</div>
          <div className="scanbox">
            <input className="mono" value={phone} placeholder="10-digit mobile number" inputMode="numeric" maxLength={10}
              autoFocus onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))}
              onKeyDown={(e) => { if (e.key === 'Enter') login(); }} />
          </div>
          <button className="btn primary" disabled={phone.replace(/\D/g, '').length !== 10} onClick={() => login()}>Login</button>
        </div>
        {roster.length > 0 && (
          <div className="card">
            <div className="small muted" style={{ marginBottom: 6 }}>Riders</div>
            {roster.map((r) => (
              <div key={r.phone} className="skuitem tap" style={{ cursor: 'pointer' }} onClick={() => { setPhone(r.phone); login(r.phone); }}>
                <div><div style={{ fontWeight: 600 }}>{r.name}</div><div className="small muted mono">{r.phone}</div></div>
                <span className="badge grey">{r.pps} PPs</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );

  if (view === 'pps') return (
    <>
      <TopBar title={rider.name} sub={`${rider.phone} · your pending pickup points`} onBack={() => { setView('login'); clearMsg(); }} />
      <div className="wrap">
        {msg && <Note kind={msg.kind}>{msg.text}</Note>}
        <div className="small muted" style={{ marginBottom: 8 }}>Sorted by RTO load — clear the busiest first.</div>
        {pps.map((p) => (
          <div key={p.pp_id} className="card tap" onClick={() => openPP(p.pp_id)}>
            <div className="row spread">
              <div style={{ fontWeight: 600 }}>{p.pp_code}</div>
              <span className={`badge ${p.total_rto_units >= 25 ? 'hot' : 'units'}`}>{p.total_rto_units} RTO units</span>
            </div>
            <div className="row spread small muted" style={{ marginTop: 6 }}>
              <span>{p.pp_cluster}</span>
              <span>{p.rto_crates} RTO · {p.empty_crates} empty{p.stale_crates ? ` · ${p.stale_crates} stale` : ''} · {STAGE_LABEL[p.stage] || p.stage}</span>
            </div>
          </div>
        ))}
        {!pps.length && <div className="center">No pending PPs 🎉</div>}
      </div>
    </>
  );

  if (view === 'pp' && pv) {
    const { pp, actions, crates, demand_units, packed_units } = pv;
    return (
      <>
        <TopBar title={pp.pp_code} sub={`${pp.pp_cluster} · ${STAGE_LABEL[pp.stage] || pp.stage}`} onBack={() => { setView('pps'); refreshPPs(); clearMsg(); }} />
        <div className="wrap">
          {msg && <Note kind={msg.kind}>{msg.text}</Note>}
          {pp.stage === 'REACHED' && <Note kind="ok">{packed_units}/{demand_units} RTO units packed</Note>}

          <div className="card">
            <div className="small muted" style={{ marginBottom: 8 }}>Crates at this PP</div>
            {crates.map((c) => {
              const [cls, lbl] = c.status === 'CREATED' && !c.eligible ? ['amber', 'Asset clearance'] : (CRATE_BADGE[c.status] || ['grey', c.status]);
              return (
                <div key={c.crate_id} className="skuitem">
                  <div>
                    <span className="mono" style={{ fontWeight: 600 }}>{c.crate_id}</span>
                    <span className="badge grey" style={{ marginLeft: 8 }}>{c.type}</span>
                    <div className="small muted">created {c.created_date}{c.type === 'RTO' ? ` · ${c.cumulative_rto} RTO units${c.load ? `, ${c.load} packed` : ''}` : ''}</div>
                  </div>
                  <span className={`badge ${cls}`}>{lbl}</span>
                </div>
              );
            })}
          </div>

          <div className="stack">
            {actions.map((a) => (
              <button key={a.key} className={`btn ${a.key.startsWith('close') || a.key === 'leave' ? 'ghost' : 'primary'}`} disabled={!a.enabled} onClick={() => doAction(a.key)}>
                {a.label}{a.reason ? ` · ${a.reason}` : ''}
              </button>
            ))}
          </div>
        </div>
        {modal && <ScanCrateModal modal={modal} onClose={() => setModal(null)} />}
      </>
    );
  }

  if (view === 'crate' && pv?.active_crate) {
    const crate = pv.active_crate;
    const pct = crate.capacity ? Math.min(100, Math.round((crate.load / crate.capacity) * 100)) : 0;
    // Closing an open crate finalises it (no seal). Active clears → back to the PP menu.
    const closeCrate = guard(async () => { const cid = crate.crate_id; setPv(await api.closeCrate(cid)); setView('pp'); flash('ok', `Crate ${cid} closed — ready for dispatch`); });
    return (
      <>
        <TopBar title={`Crate ${crate.crate_id}`} sub={`Consolidate RTO · ${crate.load}/${crate.capacity} units`} onBack={() => { setView('pp'); clearMsg(); }} />
        <div className="wrap">
          {msg && <Note kind={msg.kind}>{msg.text}</Note>}
          <div className="card">
            <div className="row spread"><span className="small muted">Crate load (units)</span><span className="small">{crate.load}/{crate.capacity}</span></div>
            <div className={`progress ${pct >= 100 ? 'full' : ''}`}><i style={{ width: `${pct}%` }} /></div>
          </div>

          <div className="card">
            <div className="small muted" style={{ marginBottom: 4 }}>RTO units at this PP — tap the SKU you're holding to scan its units into this crate</div>
            {pv.demand.map((s) => {
              const [cls, lbl] = SKU_BADGE[s.status] || ['grey', s.status];
              const tappable = s.status === 'OPEN';
              return (
                <div key={s.sku_id} className="skuitem" style={{ cursor: tappable ? 'pointer' : 'default', opacity: tappable ? 1 : .7 }}
                  onClick={() => { if (tappable) { setRedirect(null); setSkuSearch(''); setSkuId(s.sku_id); setView('sku'); clearMsg(); } }}>
                  <div>
                    <div style={{ fontWeight: 600 }}>{s.sku_name}</div>
                    <div className="small muted mono">{s.sku_id} · EAN {s.ean}</div>
                    {s.status === 'SHORT_CLOSED' && <div className="small" style={{ color: 'var(--amber)' }}>{s.missing_qty} missing</div>}
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="big" style={{ fontSize: 18 }}>{s.scanned_qty}/{s.expected_qty}</div>
                    <span className={`badge ${cls}`}>{lbl}</span>
                  </div>
                </div>
              );
            })}
          </div>

          <button className="btn ghost" onClick={closeCrate}>Done — close this crate</button>
        </div>
      </>
    );
  }

  if (view === 'sku' && pv?.active_crate) {
    const crate = pv.active_crate;
    const sku = pv.demand.find((s) => s.sku_id === skuId);
    if (!sku) { setView('crate'); return null; }
    const missing = sku.expected_qty - sku.scanned_qty;
    const applyEvent = (res, okMsg) => {
      setPv(res);
      const ev = res.event || {};
      if (ev.crate_full) return setModal({ type: 'full' });
      if (ev.demand_done) { setView('pp'); return flash('ok', 'All RTO units packed — crate closed'); }
      if (ev.sku_done) return setView('crate');
      flash('ok', okMsg(res.demand.find((s) => s.sku_id === skuId)));
    };
    // WRONG_SKU_HERE → the item belongs to another SKU; capture it so we can redirect the rider.
    const onErr = (e) => { setRedirect(e.code === 'WRONG_SKU_HERE' && e.data?.sku_id ? e.data : null); flash('err', e.message); };
    const scan = async (ean) => { try { clearMsg(); setRedirect(null); applyEvent(await api.scanEan(crate.crate_id, skuId, ean, rider?.name), (u) => `Scanned — ${u.scanned_qty}/${u.expected_qty}`); } catch (e) { onErr(e); } };
    // search-validated add: resolves the typed item and only counts it if it IS this SKU
    const identify = async () => { const q = skuSearch.trim(); if (!q) return; try { clearMsg(); setRedirect(null); const res = await api.searchAdd(crate.crate_id, skuId, q, rider?.name); setSkuSearch(''); applyEvent(res, (u) => `Confirmed ${sku.sku_name} — added, ${u.scanned_qty}/${u.expected_qty}`); } catch (e) { onErr(e); } };
    const goToSku = () => { const t = redirect; setRedirect(null); setSkuSearch(''); clearMsg(); setSkuId(t.sku_id); };
    const closeShort = guard(async () => { setPv(await api.closeSku(pv.pp.pp_id, skuId)); setModal(null); setView('crate'); });
    return (
      <>
        <TopBar title={sku.sku_name} sub={`${sku.sku_id} · scan every unit`} onBack={() => { setRedirect(null); setSkuSearch(''); setView('crate'); clearMsg(); }} />
        <div className="wrap">
          {msg && <Note kind={msg.kind}>{msg.text}</Note>}
          <div className="card" style={{ textAlign: 'center' }}>
            <div className="small muted">Units scanned into {crate.crate_id}</div>
            <div className="big">{sku.scanned_qty} <span className="muted" style={{ fontSize: 16 }}>/ {sku.expected_qty}</span></div>
            <div className="small muted mono">Accepts only EAN {sku.ean}</div>
          </div>
          <ScanInput label="Scan a unit barcode (EAN)" placeholder="Scan unit EAN" onScan={scan} cameraLabel={`Scan ${sku.sku_name}`} />

          {redirect && (<>
            <Note kind="err">That item is <b>{redirect.sku_name}</b> ({redirect.sku_id}) — not {sku.sku_name}. Add it under {redirect.sku_name}.</Note>
            <button className="btn pink" onClick={goToSku}>Go to {redirect.sku_name} →</button>
          </>)}

          {missing > 0 && (
            <div className="card" style={{ marginTop: 12 }}>
              <div className="small muted" style={{ marginBottom: 4 }}>Can’t scan / EAN tarnished? Identify the item in hand</div>
              <div className="scanbox">
                <input value={skuSearch} placeholder="SKU name or last 5 digits of EAN" onChange={(e) => setSkuSearch(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') identify(); }} />
                <button className="btn primary sm" onClick={identify}>Find &amp; add</button>
              </div>
              <div className="small muted" style={{ marginTop: 6 }}>It’s counted only if it’s actually {sku.sku_name}; otherwise we point you to the right SKU.</div>
            </div>
          )}
          {missing > 0 && <button className="btn ghost" onClick={() => setModal({ type: 'short', missing })}>Close SKU ({missing} short)</button>}

          {modal?.type === 'short' && (
            <Modal title="Close SKU with missing units?" onClose={() => setModal(null)}
              actions={<><button className="btn pink" onClick={closeShort}>Yes, close ({modal.missing} missing)</button>
                <button className="btn grey" onClick={() => setModal(null)}>Keep scanning</button></>}>
              {modal.missing} unit(s) of <b>{sku.sku_name}</b> are missing. They will be recorded as short.
            </Modal>
          )}
          {modal?.type === 'full' && (
            <Modal title="This crate is full" onClose={() => { setModal(null); setView('pp'); }}
              actions={<button className="btn primary" onClick={() => { setModal(null); setView('pp'); }}>OK, use a different crate</button>}>
              This crate is full, please use a different crate for the rest of the units. The crate has been closed automatically.
            </Modal>
          )}
        </div>
      </>
    );
  }

  return null;
}

function ScanCrateModal({ modal, onClose }) {
  return (
    <Modal title={modal.title} onClose={onClose} actions={<button className="btn grey" onClick={onClose}>Cancel</button>}>
      <div style={{ marginBottom: 10 }}>{modal.hint}</div>
      <ScanInput placeholder="Scan crate id (e.g. CR1003)" onScan={modal.onScan} buttonLabel="Bind" />
    </Modal>
  );
}

