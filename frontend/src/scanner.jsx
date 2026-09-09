import React, { useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';

// Phone-camera barcode scanner (crate ids + EANs). Prefers the rear camera. Falls back to a
// clear message if the camera is unavailable (permission denied / no secure context) so the
// rider can just type/paste the code instead.
export function CameraScanner({ label = 'Scan barcode', onDetected, onClose }) {
  const videoRef = useRef(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    const reader = new BrowserMultiFormatReader();
    let controls = null;
    let done = false;
    const stop = () => { try { controls && controls.stop(); } catch { /* noop */ } };
    reader
      .decodeFromConstraints({ video: { facingMode: { ideal: 'environment' } } }, videoRef.current, (result, _err, ctrl) => {
        controls = ctrl;
        if (result && !done) { done = true; stop(); onDetected(result.getText().trim()); }
      })
      .then((c) => { controls = c; })
      .catch((e) => setErr(e?.message || 'Camera unavailable'));
    return stop;
  }, []);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{label}</h3>
        {err
          ? <div className="note err" style={{ marginBottom: 12 }}>{err}. Type the code instead.</div>
          : <>
              <video ref={videoRef} muted playsInline style={{ width: '100%', borderRadius: 12, background: '#000', aspectRatio: '4 / 3', objectFit: 'cover' }} />
              <div className="small muted" style={{ margin: '8px 0' }}>Point the camera at the barcode.</div>
            </>}
        <button className="btn grey" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}
