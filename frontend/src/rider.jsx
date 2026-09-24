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

// Haptic feedback so riders feel the result without staring at the screen:
// ok = short, warn = double, err = long-double.
const buzz = (kind) => { try { navigator.vibrate && navigator.vibrate(kind === 'ok' ? 55 : kind === 'warn' ? [40, 60, 40] : [90, 60, 90]); } catch { /* noop */ } };

export default function RiderFlow() {
  const [view, setView] = useState('login');
  const [rider, setRider] = useState(null);   // { name, phone }
  const [roster, setRoster] = useState([]);
  const [phone, setPhone] = useState('');
  const [pps, setPps] = useState([]);
  const [pv, setPv] = useState(null);       // full PP view (single source of truth)
  const [msg, setMsg] = useState(null);
  const [fx, setFx] = useState(null);       // last scan result on the crate screen { kind, message }
  const [modal, setModal] = useState(null);
  const [searchQ, setSearchQ] = useState('');   // "can't scan?" find-by-name/EAN
  const [results, setResults] = useState([]);

  const flash = (kind, text) => setMsg({ kind, text });
  const clearMsg = () => setMsg(null);
  const guard = (fn) => async (...a) => { try { clearMsg(); await fn(...a); } catch (e) { flash('err', e.message); } };

  React.useEffect(() => { api.riders().then((r) => setRoster(r.riders)).catch(() => {}); }, []);

  // Debounced "find the item" search on the crate screen (name / EAN digits / sku_id).
  React.useEffect(() => {
    const q = searchQ.trim();
    if (q.length < 2 || view !== 'crate' || !pv?.active_crate) { setResults([]); return; }
    let cancel = false;
    const t = setTimeout(async () => {
      try { const r = await api.skuSearch(pv.pp.pp_id, q); if (!cancel) setResults(r.skus || []); }
      catch { if (!cancel) setResults([]); }
    }, 220);
    return () => { cancel = true; clearTimeout(t); };
  }, [searchQ]); // eslint-disable-line react-hooks/exhaustive-deps

  const login = guard(async (num) => { const res = await api.login(num ?? phone); setRider(res.rider); setPps(res.pps); setView('pps'); });
  const refreshPPs = async () => setPps((await api.riderPPs(rider.phone)).pps);
  const openPP = guard(async (ppId) => { setPv(await api.pp(ppId)); setView('pp'); });

  const doAction = guard(async (key) => {
    const ppId = pv.pp.pp_id;
    if (key === 'reach') return setPv(await api.reach(ppId));
    if (key === 'close_all_rto') { setPv(await api.closeRto(ppId)); return flash('ok', 'All RTO crates closed'); }
    if (key === 'close_all_empty') { setPv(await api.closeEmpty(ppId)); return flash('ok', 'All empty crates closed'); }
    if (key === 'leave') { await api.leave(ppId); await refreshPPs(); setView('pps'); return flash('ok', `${pv.pp.pp_code} closed`); }
    if (key === 'scan_ean') { setFx(null); return setView('crate'); }
    if (key === 'scan_rto_crate') {
      return setModal({
        title: 'Scan RTO Crate', hint: 'Scan an available crate to fill this PP’s RTO units into.',
        okWord: 'ready to fill', run: async (id) => { setPv(await api.scanRtoCrate(ppId, id)); },
        done: () => { setFx(null); setView('crate'); },
      });
    }
    if (key === 'scan_empty_crate') {
      return setModal({
        title: 'Scan Empty Crate', hint: 'Empty crates don’t need sealing — just scan to return them.',
        okWord: 'returned empty', run: async (id) => { setPv(await api.scanEmptyCrate(ppId, id)); },
        done: () => flash('ok', 'Empty crate scanned'),
      });
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
    // Show ONE crate type at a time to avoid confusion: RTO crates during the RTO phase, then only
    // empties once all RTO crates are closed. (Empties = EMPTY crates + RTO crates left unpacked.)
    const rtoPhase = pp.stage === 'PENDING' || pp.stage === 'REACHED';
    const visibleCrates = crates.filter((c) => rtoPhase ? c.type === 'RTO' : (c.type === 'EMPTY' || c.load === 0));
    return (
      <>
        <TopBar title={pp.pp_code} sub={`${pp.pp_cluster} · ${STAGE_LABEL[pp.stage] || pp.stage}`} onBack={() => { setView('pps'); refreshPPs(); clearMsg(); }} />
        <div className="wrap">
          {msg && <Note kind={msg.kind}>{msg.text}</Note>}
          {pp.stage === 'REACHED' && <Note kind="ok">{packed_units}/{demand_units} RTO units packed</Note>}

          <div className="card">
            <div className="small muted" style={{ marginBottom: 8 }}>{rtoPhase ? 'RTO crates to pick at this PP' : 'Empty crates to return'}</div>
            {visibleCrates.length ? visibleCrates.map((c) => {
              const [cls, lbl] = c.status === 'CREATED' && !c.eligible ? ['amber', 'Asset clearance'] : (CRATE_BADGE[c.status] || ['grey', c.status]);
              const typeLabel = rtoPhase ? c.type : 'EMPTY';
              return (
                <div key={c.crate_id} className="skuitem">
                  <div>
                    <span className="mono" style={{ fontWeight: 600 }}>{c.crate_id}</span>
                    <span className="badge grey" style={{ marginLeft: 8 }}>{typeLabel}</span>
                    <div className="small muted">created {c.created_date}{rtoPhase && c.type === 'RTO' ? ` · ${c.cumulative_rto} RTO units${c.load ? `, ${c.load} packed` : ''}` : ''}</div>
                  </div>
                  <span className={`badge ${cls}`}>{lbl}</span>
                </div>
              );
            }) : <div className="small muted">{rtoPhase ? 'No RTO crates at this PP.' : 'No empty crates to return.'}</div>}
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

  // ---- scan-first crate screen: scan any unit; the app identifies it and counts it ----
  if (view === 'crate' && pv?.active_crate) {
    const crate = pv.active_crate;
    const pct = crate.capacity ? Math.min(100, Math.round((crate.load / crate.capacity) * 100)) : 0;
    const expected = pv.demand.filter((s) => s.expected_qty > 0);
    const extras = pv.demand.filter((s) => s.expected_qty === 0 && s.scanned_qty > 0);

    const scan = async (code) => {
      clearMsg();
      try {
        const res = await api.scanUnit(crate.crate_id, code, rider?.name);
        const ev = res.event || {};
        const kind = ev.kind || 'ok';
        setPv(res); buzz(kind);
        if (ev.crate_full) { setFx(null); setView('pp'); return flash('warn', ev.message); }
        setFx({ kind, message: ev.message });
      } catch (e) { buzz('err'); setFx({ kind: 'err', message: e.message }); }
    };
    const closeCrate = guard(async () => { const cid = crate.crate_id; setPv(await api.closeCrate(cid)); setView('pp'); flash('ok', `Crate ${cid} closed — ready for dispatch`); });
    const pickResult = (s) => { setSearchQ(''); setResults([]); scan(s.sku_id); };

    return (
      <>
        <TopBar title={`Crate ${crate.crate_id}`} sub={`Scan units · ${crate.load}/${crate.capacity}`} onBack={() => { setView('pp'); setFx(null); clearMsg(); }} />
        <div className="wrap">
          {msg && <Note kind={msg.kind}>{msg.text}</Note>}

          {/* big, unmissable result of the last scan */}
          <div className={`scanfx ${fx ? fx.kind : 'idle'}`}>
            {fx ? (<><span className="scanfx-ic">{fx.kind === 'ok' ? '✓' : fx.kind === 'warn' ? '!' : '✕'}</span><span>{fx.message}</span></>)
              : <span className="muted">Scan a unit to begin — the app will identify it.</span>}
          </div>

          <ScanInput label="Scan any unit barcode / EAN" placeholder="Scan or type barcode" onScan={scan} cameraLabel="Scan unit" />

          <div className="card">
            <div className="small muted" style={{ marginBottom: 4 }}>Can't scan the barcode? Find the item by name or EAN</div>
            <div className="scanbox"><input value={searchQ} placeholder="Type name or last digits of EAN" onChange={(e) => setSearchQ(e.target.value)} /></div>
            {results.length > 0 && (
              <div className="stack" style={{ marginTop: 8 }}>
                {results.map((s) => (
                  <div key={s.sku_id} className="skuitem tap" style={{ cursor: 'pointer' }} onClick={() => pickResult(s)}>
                    <div><div style={{ fontWeight: 600 }}>{s.sku_name}</div><div className="small muted mono">{s.sku_id}{s.ean ? ` · EAN ${s.ean}` : ''}</div></div>
                    {s.expected_here ? <span className="badge units">{s.scanned}/{s.expected}</span> : <span className="badge grey">extra</span>}
                  </div>
                ))}
              </div>
            )}
            {searchQ.trim().length >= 2 && !results.length && <div className="small muted" style={{ marginTop: 6 }}>No matching item — check the name, or scan the barcode.</div>}
          </div>

          <div className="card">
            <div className="row spread"><span className="small muted">Crate load</span><span className="small">{crate.load}/{crate.capacity}</span></div>
            <div className={`progress ${pct >= 100 ? 'full' : ''}`}><i style={{ width: `${pct}%` }} /></div>
          </div>

          <div className="card">
            <div className="small muted" style={{ marginBottom: 6 }}>Expected at this PP</div>
            {expected.length ? expected.map((s) => {
              const [cls, lbl] = SKU_BADGE[s.status] || ['grey', s.status];
              const done = s.scanned_qty >= s.expected_qty;
              return (
                <div key={s.sku_id} className="skuitem">
                  <div>
                    <div style={{ fontWeight: 600 }}>{s.sku_name}</div>
                    <div className="small muted mono">{s.sku_id}{s.ean ? ` · EAN ${s.ean}` : ''}</div>
                    {s.status === 'SHORT_CLOSED' && <div className="small" style={{ color: 'var(--amber)' }}>{s.missing_qty} missing</div>}
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="big" style={{ fontSize: 18, color: done ? 'var(--green)' : 'inherit' }}>{s.scanned_qty}/{s.expected_qty}</div>
                    <span className={`badge ${cls}`}>{lbl}</span>
                  </div>
                </div>
              );
            }) : <div className="small muted">No expected RTO units — scan empties instead.</div>}
          </div>

          {extras.length > 0 && (
            <div className="card">
              <div className="small muted" style={{ marginBottom: 6 }}>Extra scanned (not in today's list)</div>
              {extras.map((s) => (
                <div key={s.sku_id} className="skuitem">
                  <div><div style={{ fontWeight: 600 }}>{s.sku_name}</div><div className="small muted mono">{s.sku_id}</div></div>
                  <div className="big" style={{ fontSize: 18 }}>{s.scanned_qty}</div>
                </div>
              ))}
            </div>
          )}

          <button className="btn ghost" onClick={closeCrate}>Done — close this crate</button>
        </div>
        {modal?.type === 'full' && (
          <Modal title="This crate is full" onClose={() => { setModal(null); setView('pp'); }}
            actions={<button className="btn primary" onClick={() => { setModal(null); setView('pp'); }}>OK, use a different crate</button>}>
            The crate is full and has been closed automatically. Scan a new RTO crate for the remaining units.
          </Modal>
        )}
      </>
    );
  }

  return null;
}

// Crate-scan modal with clear ✓/✗ feedback. Stays open on error so the rider can retry; on
// success it confirms, buzzes, then advances.
function ScanCrateModal({ modal, onClose }) {
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const handle = async (id) => {
    if (busy) return;
    setBusy(true); setResult(null);
    try {
      await modal.run(id);
      buzz('ok');
      setResult({ ok: true, text: `✓ ${id} — ${modal.okWord || 'scanned'}` });
      setTimeout(() => { onClose(); modal.done && modal.done(); }, 800);
    } catch (e) {
      buzz('err');
      setResult({ ok: false, text: `✕ ${e.message}` });
    } finally { setBusy(false); }
  };
  return (
    <Modal title={modal.title} onClose={onClose} actions={<button className="btn grey" onClick={onClose}>Cancel</button>}>
      <div style={{ marginBottom: 10 }}>{modal.hint}</div>
      {result && <div className={`note ${result.ok ? 'ok' : 'err'}`} style={{ marginBottom: 10, fontWeight: 600 }}>{result.text}</div>}
      {!result?.ok && <ScanInput placeholder="Scan crate id" onScan={handle} buttonLabel="Scan" />}
    </Modal>
  );
}
