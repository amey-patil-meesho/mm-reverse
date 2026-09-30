import React, { useEffect, useRef, useState } from 'react';
import { TopBar, Note } from './ui.jsx';

// Ground-ops supervisor board — read-only live rider progress so the supervisor can nudge.
// Auth is a code only (the ops code, or the admin code). No email, no upload/reset controls.

const AUTO_MS = 30000;   // auto-refresh cadence

function ago(iso) {
  if (!iso) return null;
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60); return `${h}h ${mins % 60}m ago`;
}

function Bar({ done, total }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div style={{ background: 'var(--line,#e6e6e6)', borderRadius: 999, height: 8, overflow: 'hidden', margin: '6px 0' }}>
      <div style={{ width: pct + '%', height: '100%', background: pct === 100 ? '#1a7f37' : '#2f6feb', transition: 'width .3s' }} />
    </div>
  );
}

function RiderCard({ r }) {
  const [open, setOpen] = useState(false);
  const done = r.pending_pps === 0;
  const idleMin = r.last_activity ? Math.round((Date.now() - new Date(r.last_activity).getTime()) / 60000) : null;
  const stalled = !done && (r.pps_done === 0 || idleMin === null || idleMin >= 45);
  const flag = done ? { t: '✅ done', c: '#1a7f37' } : stalled ? { t: '🔴 needs a nudge', c: '#b3261e' } : { t: '🟡 in progress', c: '#8a6d00' };
  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <div className="row spread" style={{ alignItems: 'baseline' }}>
        <div><b>{r.name || r.phone}</b> <span className="muted small">· {r.phone}</span></div>
        <span className="small" style={{ color: flag.c, fontWeight: 600 }}>{flag.t}</span>
      </div>
      <Bar done={r.pps_done} total={r.total_pps} />
      <div className="row spread small">
        <span className="muted">{r.pps_done}/{r.total_pps} PPs done</span>
        <span className="muted">{r.pending_crates} crates pending{r.pending_rto_crates ? ` (${r.pending_rto_crates} RTO)` : ''}</span>
      </div>
      <div className="row spread small" style={{ marginTop: 4 }}>
        <span className="muted">last scan: {ago(r.last_activity) || 'none yet'}</span>
        {r.open_pps.length > 0 && (
          <button className="btn ghost sm" onClick={() => setOpen((v) => !v)}>{open ? 'Hide' : `${r.open_pps.length} open PP${r.open_pps.length > 1 ? 's' : ''}`}</button>
        )}
      </div>
      {open && (
        <div className="stack" style={{ marginTop: 8, borderTop: '1px solid var(--line,#eee)', paddingTop: 8 }}>
          {r.open_pps.map((pp) => (
            <div key={pp.pp_code} className="row spread small">
              <span><b className="mono">{pp.pp_code}</b> <span className="muted">· {pp.cluster}</span></span>
              <span className="muted">{pp.pending_crates}/{pp.total_crates} pending · {pp.stage}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function OpsFlow() {
  const [code, setCode] = useState(null);
  const [entry, setEntry] = useState('');
  const [msg, setMsg] = useState(null);
  const [board, setBoard] = useState(null);
  const [auto, setAuto] = useState(true);
  const [loadedAt, setLoadedAt] = useState(null);
  const timer = useRef(null);

  const load = async (c = code) => {
    try {
      const r = await fetch('/api/ops/board', { headers: { 'x-ops-code': c } });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setBoard(await r.json()); setLoadedAt(new Date()); setMsg(null);
    } catch (e) { setMsg({ kind: 'err', text: e.message }); }
  };

  const login = async () => {
    try {
      setMsg(null);
      const c = entry.trim();
      const r = await fetch('/api/ops/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: c }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Invalid access code');
      setCode(c); load(c);
    } catch (e) { setMsg({ kind: 'err', text: e.message }); }
  };

  useEffect(() => {
    if (!code) return;
    if (timer.current) clearInterval(timer.current);
    if (auto) timer.current = setInterval(() => load(), AUTO_MS);
    return () => timer.current && clearInterval(timer.current);
  }, [code, auto]);

  if (!code) return (
    <>
      <TopBar title="Ops board" sub="Ground-ops supervisor — live tracking" />
      <div className="wrap">
        {msg && <Note kind={msg.kind}>{msg.text}</Note>}
        <Note kind="warn">Enter the ops access code shared with you.</Note>
        <div className="card">
          <div className="small muted" style={{ marginBottom: 4 }}>Access code</div>
          <div className="scanbox">
            <input className="mono" value={entry} placeholder="access code" autoFocus
              onChange={(e) => setEntry(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') login(); }} />
          </div>
          <button className="btn primary" disabled={!entry.trim()} onClick={login}>View live board</button>
        </div>
      </div>
    </>
  );

  const t = board?.totals;
  return (
    <>
      <TopBar title="Ops board" sub="Live rider tracking" onBack={() => { setCode(null); setBoard(null); setEntry(''); setMsg(null); }} />
      <div className="wrap">
        {msg && <Note kind={msg.kind}>{msg.text}</Note>}
        <div className="card">
          <div className="row spread">
            <div className="small muted">
              {loadedAt ? `Updated ${loadedAt.toLocaleTimeString()}` : 'Loading…'}
              {auto && <span className="muted"> · auto every 30s</span>}
            </div>
            <div className="row" style={{ gap: 6 }}>
              <button className="btn ghost sm" onClick={() => setAuto((v) => !v)}>{auto ? '⏸ Pause' : '▶ Auto'}</button>
              <button className="btn ghost sm" onClick={() => load()}>↻ Refresh</button>
            </div>
          </div>
          {t && (
            <div className="row spread small" style={{ marginTop: 10, textAlign: 'center' }}>
              <div style={{ flex: 1 }}><div style={{ fontSize: 22, fontWeight: 700 }}>{t.pending_pps}</div><div className="muted">PPs pending</div></div>
              <div style={{ flex: 1 }}><div style={{ fontSize: 22, fontWeight: 700 }}>{t.pending_crates}</div><div className="muted">crates pending</div></div>
              <div style={{ flex: 1 }}><div style={{ fontSize: 22, fontWeight: 700, color: '#1a7f37' }}>{t.done_crates}</div><div className="muted">crates done</div></div>
            </div>
          )}
        </div>
        {board?.riders?.length
          ? board.riders.map((r) => <RiderCard key={r.phone} r={r} />)
          : <div className="small muted">No riders loaded yet.</div>}
      </div>
    </>
  );
}
