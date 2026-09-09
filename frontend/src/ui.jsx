import React, { useEffect, useRef, useState } from 'react';
import { CameraScanner } from './scanner.jsx';

export function TopBar({ title, sub, onBack }) {
  return (
    <div className="topbar">
      {onBack && <button className="back" onClick={onBack}>‹</button>}
      <h1>{title}{sub && <div className="sub">{sub}</div>}</h1>
    </div>
  );
}

export function Note({ kind = 'ok', children }) {
  if (!children) return null;
  return <div className={`note ${kind}`}>{children}</div>;
}

export function Modal({ title, children, onClose, actions }) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        {title && <h3>{title}</h3>}
        <div className="muted small" style={{ marginBottom: 14 }}>{children}</div>
        {actions}
      </div>
    </div>
  );
}

// A scan field: use the phone camera, or type/scan a code and press Enter (hardware
// scanners emit Enter). The 📷 button opens the camera and fills the field on detection.
export function ScanInput({ label, placeholder, onScan, autoFocus = true, buttonLabel = 'Scan', cameraLabel = 'Scan barcode', camera = true }) {
  const ref = useRef(null);
  const [cam, setCam] = useState(false);
  useEffect(() => { if (autoFocus && ref.current) ref.current.focus(); }, [autoFocus]);
  const fire = (val) => {
    const v = (val ?? ref.current.value).trim();
    if (!v) return;
    onScan(v);
    if (ref.current) { ref.current.value = ''; ref.current.focus(); }
  };
  return (
    <div>
      {label && <div className="small muted" style={{ marginBottom: 4 }}>{label}</div>}
      <div className="scanbox">
        {camera && <button className="btn ghost sm" title="Scan with camera" onClick={() => setCam(true)}>📷</button>}
        <input ref={ref} placeholder={placeholder || 'Scan / type barcode'} inputMode="text"
          onKeyDown={(e) => { if (e.key === 'Enter') fire(); }} />
        <button className="btn primary sm" onClick={() => fire()}>{buttonLabel}</button>
      </div>
      {cam && <CameraScanner label={cameraLabel} onClose={() => setCam(false)}
        onDetected={(code) => { setCam(false); fire(code); }} />}
    </div>
  );
}
