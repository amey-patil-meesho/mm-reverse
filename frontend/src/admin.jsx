import React, { useState } from 'react';
import { api } from './api.js';
import { TopBar, Note } from './ui.jsx';

export default function AdminFlow() {
  const [auth, setAuth] = useState(null);      // { email, code }
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [counts, setCounts] = useState(null);
  const [riders, setRiders] = useState(null);

  const authed = (path, opts = {}) => fetch(path, { ...opts, headers: { 'x-admin-code': auth?.code, ...(opts.headers || {}) } });

  const refreshCounts = async (c = auth?.code) => {
    try { const r = await fetch('/api/admin/counts', { headers: { 'x-admin-code': c } }); if (r.ok) setCounts(await r.json()); } catch { /* ignore */ }
  };
  const loadRiders = async (c = auth?.code) => {
    try { const r = await fetch('/api/admin/riders', { headers: { 'x-admin-code': c } }); if (r.ok) setRiders((await r.json()).riders); } catch { /* ignore */ }
  };

  const login = async () => {
    try {
      setMsg(null);
      const res = await api.adminLogin(email.trim(), code.trim());
      const c = code.trim();
      setAuth({ email: res.email, code: c });
      refreshCounts(c); loadRiders(c);
    } catch (e) { setMsg({ kind: 'err', text: e.message }); }
  };

  const download = async (path, name) => {
    try {
      setMsg(null);
      const r = await authed(path);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement('a');
      a.href = url; a.download = `${name}_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    } catch (e) { setMsg({ kind: 'err', text: 'Download failed: ' + e.message }); }
  };

  const upload = async (file) => {
    if (!file) return;
    try {
      setBusy(true); setMsg(null);
      const dataUrl = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(file); });
      const r = await authed('/api/admin/upload', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ filename: file.name, data_base64: dataUrl }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setMsg({ kind: 'ok', text: `Loaded ${file.name}: ${d.data_rows} rows → ${d.added} crates across ${d.riders} rider(s)${d.unresolved ? `, ${d.unresolved} rows had no rider match` : ''}.` });
      refreshCounts(); loadRiders();
    } catch (e) { setMsg({ kind: 'err', text: 'Upload failed: ' + e.message }); }
    finally { setBusy(false); }
  };

  const reset = async () => {
    if (!confirm('Clear ALL data (test scans + pending crates)? Riders and crates reload on the next Sync out / auto-sync. Use this to wipe test data before a fresh rollout.')) return;
    try {
      setBusy(true); setMsg(null);
      const r = await authed('/api/admin/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setMsg({ kind: 'ok', text: d.message || 'All data cleared.' });
      refreshCounts(); loadRiders();
    } catch (e) { setMsg({ kind: 'err', text: 'Reset failed: ' + e.message }); }
    finally { setBusy(false); }
  };

  if (!auth) return (
    <>
      <TopBar title="Admin" sub="Data access — Meesho admins only" />
      <div className="wrap">
        {msg && <Note kind={msg.kind}>{msg.text}</Note>}
        <Note kind="warn">Restricted. Log in with your Meesho email and the access code shared with you over mail.</Note>
        <div className="card">
          <div className="small muted" style={{ marginBottom: 4 }}>Meesho email</div>
          <div className="scanbox"><input value={email} placeholder="you@meesho.com" inputMode="email" autoFocus onChange={(e) => setEmail(e.target.value)} /></div>
          <div className="small muted" style={{ margin: '14px 0 4px' }}>Access code</div>
          <div className="scanbox"><input className="mono" value={code} placeholder="access code" onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') login(); }} /></div>
          <button className="btn primary" disabled={!email.trim() || !code.trim()} onClick={login}>Login</button>
        </div>
      </div>
    </>
  );

  return (
    <>
      <TopBar title="Admin" sub={auth.email} onBack={() => { setAuth(null); setCode(''); setMsg(null); setRiders(null); setCounts(null); }} />
      <div className="wrap">
        {msg && <Note kind={msg.kind}>{msg.text}</Note>}

        <div className="card">
          <div className="small muted" style={{ marginBottom: 8 }}>Load rider data (Excel / CSV workbook)</div>
          <label className="btn primary" style={{ display: 'block', textAlign: 'center', cursor: 'pointer' }}>
            {busy ? 'Loading…' : '⬆ Upload rider workbook'}
            <input type="file" accept=".xlsx,.xls,.csv" hidden disabled={busy} onChange={(e) => upload(e.target.files?.[0])} />
          </label>
          <div className="small muted" style={{ marginTop: 8, lineHeight: 1.6 }}>
            One workbook with a tab per rider (crate rows), plus an <b>Admin</b> tab (name · number · route),
            an <b>EAN SKU Details</b> tab, and route tabs for shop names. Re-uploading refreshes pending crates
            without disturbing in-progress scans.
          </div>
        </div>

        <div className="card">
          <div className="row spread">
            <div className="small muted">Live data</div>
            <button className="btn ghost sm" onClick={() => { refreshCounts(); loadRiders(); }}>↻ Refresh</button>
          </div>
          {counts ? (
            <div className="small" style={{ marginTop: 8, lineHeight: 1.9 }}>
              <div className="row spread"><span className="muted">Crates scanned by riders</span><b>{counts.crates_scanned}</b></div>
              <div className="row spread"><span className="muted">Units scanned</span><b>{counts.rider_scan_units}</b></div>
              <div className="row spread"><span className="muted">Completed (left PP)</span><b>{counts.dispatched_crates}</b></div>
              <div className="row spread"><span className="muted">Pending crates</span><b>{counts.pending_crates}</b></div>
            </div>
          ) : <div className="small muted" style={{ marginTop: 8 }}>Tap Refresh to load latest counts.</div>}
        </div>

        <div className="card">
          <div className="row spread" style={{ marginBottom: 8 }}>
            <div className="small muted">Scan data by rider</div>
            <button className="btn ghost sm" onClick={() => download('/api/pc/rider-scans.csv', 'mm_rider_scans_all')}>⬇ All</button>
          </div>
          {riders && riders.length ? (
            <div className="stack">
              {riders.map((r) => (
                <div key={r.phone} className="row spread" style={{ alignItems: 'center', gap: 8 }}>
                  <div className="small">
                    <b>{r.name || r.phone}</b> <span className="muted">· {r.phone}</span><br />
                    <span className="muted">{r.pps} PP · {r.scanned_crates} crates scanned · {r.pps_done} done</span>
                  </div>
                  <button className="btn ghost sm" onClick={() => download(`/api/admin/scan-data.csv?phone=${encodeURIComponent(r.phone)}`, `scans_${(r.name || r.phone).replace(/\s+/g, '_')}`)}>⬇ CSV</button>
                </div>
              ))}
            </div>
          ) : <div className="small muted">No riders loaded yet. Upload a workbook above.</div>}
        </div>

        <div className="card">
          <div className="small muted" style={{ marginBottom: 8 }}>Reset (clear test data)</div>
          <button className="btn ghost" disabled={busy} onClick={reset} style={{ color: '#b3261e', borderColor: '#f0c0bb' }}>
            ⟲ Clear all data
          </button>
          <div className="small muted" style={{ marginTop: 8 }}>Wipes scans + pending crates. Fresh data reloads on the next Sync out (or the 5-min auto-sync).</div>
        </div>
      </div>
    </>
  );
}
