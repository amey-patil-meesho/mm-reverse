import React, { useState } from 'react';
import RiderFlow from './rider.jsx';
import AdminFlow from './admin.jsx';

// Scope for now: MM-rider scanning + an Admin data download. (No PC receiving, no asset clearance.)
export default function App() {
  const [mode, setMode] = useState('rider');
  const tab = (key, label) => (
    <button className={mode === key ? 'on' : ''} onClick={() => setMode(key)}>{label}</button>
  );
  return (
    <>
      <div className="seg">
        {tab('rider', 'MM Rider')}
        {tab('admin', 'Admin')}
      </div>
      {mode === 'rider' ? <RiderFlow /> : <AdminFlow />}
    </>
  );
}
