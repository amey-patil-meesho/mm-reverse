import React, { useState } from 'react';
import RiderFlow from './rider.jsx';
import AdminFlow from './admin.jsx';
import OpsFlow from './ops.jsx';

// Scope for now: MM-rider scanning, a live Ops board for supervisors, + an Admin data download.
export default function App() {
  const [mode, setMode] = useState('rider');
  const tab = (key, label) => (
    <button className={mode === key ? 'on' : ''} onClick={() => setMode(key)}>{label}</button>
  );
  return (
    <>
      <div className="seg">
        {tab('rider', 'MM Rider')}
        {tab('ops', 'Ops')}
        {tab('admin', 'Admin')}
      </div>
      {mode === 'rider' ? <RiderFlow /> : mode === 'ops' ? <OpsFlow /> : <AdminFlow />}
    </>
  );
}
