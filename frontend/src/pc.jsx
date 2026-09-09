import React, { useEffect, useState } from 'react';
import { api } from './api.js';
import { TopBar, Note, Modal } from './ui.jsx';

export default function PcFlow() {
  const [poc, setPoc] = useState(null);       // { pc, phone }
  const [roster, setRoster] = useState([]);
  const [phone, setPhone] = useState('');
  const [tab, setTab] = useState('inbound');
  const [inbound, setInbound] = useState([]);
  const [rows, setRows] = useState([]);
  const [msg, setMsg] = useState(null);
  const [receiving, setReceiving] = useState(null);

  useEffect(() => { api.pcRoster().then((r) => setRoster(r.pocs)).catch(() => {}); }, []);

  const login = async (num) => {
    try {
      setMsg(null);
      const res = await api.pcLogin(num ?? phone);
      setPoc({ pc: res.pc, phone: res.phone });
      setInbound(res.inbound); setRows(res.endstate);
    } catch (e) { setMsg({ kind: 'err', text: e.message }); }
  };
  const load = async () => {
    const [i, e] = await Promise.all([api.pcInbound(poc.pc), api.pcEndstate(poc.pc)]);
    setInbound(i.crates); setRows(e.rows);
  };

  const receive = async (crate, crateId) => {
    try {
      setMsg(null);
      const res = await api.pcReceive(crateId, poc.pc);
      setReceiving(null);
      await load();
      setMsg({ kind: 'ok', text: res.eligible_for_rps ? `${res.crate_id} received — eligible for Reverse Primary Sorting` : `${res.crate_id} received — empty crate unblocked` });
    } catch (e) { setMsg({ kind: 'err', text: e.message }); }
  };

  // ---- login gate ----
  if (!poc) return (
    <>
      <TopBar title="PC Receiving" sub="Receiver login" />
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
            <div className="small muted" style={{ marginBottom: 6 }}>Demo PC receivers (placeholder numbers)</div>
            {roster.map((r) => (
              <div key={r.phone} className="skuitem tap" style={{ cursor: 'pointer' }} onClick={() => { setPhone(r.phone); login(r.phone); }}>
                <div><div style={{ fontWeight: 600 }}>{r.pc}</div><div className="small muted mono">{r.phone}</div></div>
                <span className="badge grey">{r.inbound} inbound</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );

  return (
    <>
      <TopBar title={`PC ${poc.pc}`} sub={`${poc.phone} · receive crates`} onBack={() => { setPoc(null); setPhone(''); setMsg(null); }} />
      <div className="seg" style={{ marginTop: 0 }}>
        <button className={tab === 'inbound' ? 'on' : ''} onClick={() => setTab('inbound')}>Inbound ({inbound.length})</button>
        <button className={tab === 'endstate' ? 'on' : ''} onClick={() => setTab('endstate')}>Endstate ({rows.length})</button>
      </div>
      <div className="wrap">
        {msg && <Note kind={msg.kind}>{msg.text}</Note>}

        {tab === 'inbound' && (
          inbound.length ? inbound.map((c) => (
            <div key={c.crate_id} className="card tap" onClick={() => setReceiving(c)}>
              <div className="row spread">
                <span className="mono" style={{ fontWeight: 600 }}>{c.crate_id}</span>
                <span className={`badge ${c.type === 'RTO' ? 'units' : 'grey'}`}>{c.type}</span>
              </div>
              <div className="row spread small muted" style={{ marginTop: 6 }}>
                <span>{c.pp_code} · {c.mm_rider}</span>
                <span>{c.type === 'RTO' ? `${c.units} units` : 'empty'} · crate scan</span>
              </div>
            </div>
          )) : <div className="center">No crates inbound to {poc.pc}.<br /><span className="small">Complete a rider pickup, then leave the PP.</span></div>
        )}

        {tab === 'endstate' && (<>
          {rows.length ? (
            <div className="card" style={{ overflowX: 'auto' }}>
              <table>
                <thead><tr><th>Crate</th><th>PP</th><th>Type</th><th>Units</th><th>Outcome</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.crate_id}>
                      <td className="mono">{r.crate_id}</td>
                      <td>{r.pp_code}</td>
                      <td>{r.type}</td>
                      <td>{r.type === 'RTO' ? r.total_units_scanned : '—'}</td>
                      <td><span className={`badge ${r.eligible_for_rps ? 'green' : 'blue'}`}>{r.eligible_for_rps ? 'RPS eligible' : 'Unblocked'}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <div className="center">Nothing received yet — receive crates to populate it.</div>}
        </>)}
      </div>

      {receiving && <ReceiveModal crate={receiving} onClose={() => setReceiving(null)} onReceive={receive} />}
    </>
  );
}

function ReceiveModal({ crate, onClose, onReceive }) {
  const [crateId, setCrateId] = useState('');
  return (
    <Modal title={`Receive ${crate.crate_id}`} onClose={onClose}
      actions={<>
        <button className="btn primary" disabled={!crateId.trim()} onClick={() => onReceive(crate, crateId.trim())}>Receive at PC</button>
        <button className="btn grey" onClick={onClose}>Cancel</button>
      </>}>
      {crate.type === 'RTO' ? `RTO crate (${crate.units} units) — scan the crate id.` : 'Empty crate — scan the crate id.'}
      <div className="scanbox" style={{ marginTop: 12 }}>
        <input className="mono" value={crateId} placeholder="Scan crate id" autoFocus onChange={(e) => setCrateId(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && crateId.trim()) onReceive(crate, crateId.trim()); }} />
      </div>
    </Modal>
  );
}
