import React, { useEffect, useState } from 'react';
import { api } from './api.js';
import { TopBar, Note } from './ui.jsx';

export default function ClearanceFlow() {
  const [crates, setCrates] = useState([]);
  const [msg, setMsg] = useState(null);

  const load = async () => setCrates((await api.clearance()).crates);
  useEffect(() => { load(); }, []);

  const clear = async (id) => {
    try { setMsg(null); await api.clearCrate(id); await load(); setMsg({ kind: 'ok', text: `${id} routed to asset clearance` }); }
    catch (e) { setMsg({ kind: 'err', text: e.message }); }
  };

  const pending = crates.filter((c) => c.status === 'CREATED');
  const cleared = crates.filter((c) => c.status === 'CLEARED');

  return (
    <>
      <TopBar title="Asset Clearance" sub="Crates unpicked past their pickup window" />
      <div className="wrap">
        {msg && <Note kind={msg.kind}>{msg.text}</Note>}
        <Note kind="warn">A crate not picked within 4 days of its created date is no longer eligible for pickup and must be cleared as an asset.</Note>

        <div className="small muted" style={{ margin: '6px 0' }}>Awaiting clearance ({pending.length})</div>
        {pending.map((c) => (
          <div key={c.crate_id} className="card">
            <div className="row spread">
              <span className="mono" style={{ fontWeight: 600 }}>{c.crate_id}</span>
              <span className="badge grey">{c.type}</span>
            </div>
            <div className="row spread small muted" style={{ margin: '6px 0' }}>
              <span>{c.pp_code} · {c.pp_cluster}</span>
              <span>created {c.created_date} · due {c.deadline}</span>
            </div>
            <button className="btn ghost sm" style={{ width: '100%' }} onClick={() => clear(c.crate_id)}>Mark cleared (asset write-off)</button>
          </div>
        ))}
        {!pending.length && <div className="center small">Nothing awaiting clearance.</div>}

        {cleared.length > 0 && (
          <>
            <div className="small muted" style={{ margin: '14px 0 6px' }}>Cleared ({cleared.length})</div>
            {cleared.map((c) => (
              <div key={c.crate_id} className="skuitem">
                <div><span className="mono" style={{ fontWeight: 600 }}>{c.crate_id}</span> <span className="small muted">{c.pp_code} · {c.type}</span></div>
                <span className="badge green">Cleared</span>
              </div>
            ))}
          </>
        )}
      </div>
    </>
  );
}
