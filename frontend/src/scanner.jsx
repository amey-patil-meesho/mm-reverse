import React, { useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { DecodeHintType, BarcodeFormat } from '@zxing/library';

// Restrict to the formats we actually use + TRY_HARDER — this decodes faster and from further
// away / worse angles than scanning every possible format.
const HINTS = new Map();
HINTS.set(DecodeHintType.POSSIBLE_FORMATS, [
  BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
  BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.ITF,
  BarcodeFormat.QR_CODE, BarcodeFormat.DATA_MATRIX,
]);
HINTS.set(DecodeHintType.TRY_HARDER, true);

// Phone-camera scanner (crate ids + EANs). Rear camera, high resolution, continuous autofocus,
// and a torch toggle for low light. Falls back to a clear "type it instead" message.
export function CameraScanner({ label = 'Scan barcode', onDetected, onClose }) {
  const videoRef = useRef(null);
  const trackRef = useRef(null);
  const [err, setErr] = useState(null);
  const [torch, setTorch] = useState({ available: false, on: false });

  useEffect(() => {
    const reader = new BrowserMultiFormatReader(HINTS);
    let controls = null, done = false;
    const stop = () => {
      try { controls && controls.stop(); } catch { /* noop */ }
      try { const t = trackRef.current; t && t.stop && t.stop(); } catch { /* noop */ }
    };
    reader.decodeFromConstraints(
      { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } },
      videoRef.current,
      (result, _e, ctrl) => { controls = ctrl; if (result && !done) { done = true; stop(); onDetected(result.getText().trim()); } },
    ).then((c) => {
      controls = c;
      const stream = videoRef.current && videoRef.current.srcObject;
      const track = stream && stream.getVideoTracks && stream.getVideoTracks()[0];
      trackRef.current = track;
      if (track) {
        try { track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch { /* noop */ }
        try { const caps = track.getCapabilities ? track.getCapabilities() : {}; if (caps && caps.torch) setTorch({ available: true, on: false }); } catch { /* noop */ }
      }
    }).catch((e) => setErr(e?.message || 'Camera unavailable'));
    return stop;
  }, []);

  const toggleTorch = async () => {
    const t = trackRef.current; if (!t) return;
    const on = !torch.on;
    try { await t.applyConstraints({ advanced: [{ torch: on }] }); setTorch((s) => ({ ...s, on })); } catch { /* noop */ }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{label}</h3>
        {err
          ? <div className="note err" style={{ marginBottom: 12 }}>{err}. Type the code instead.</div>
          : <>
              <div style={{ position: 'relative' }}>
                <video ref={videoRef} muted playsInline style={{ width: '100%', borderRadius: 12, background: '#000', aspectRatio: '3 / 4', objectFit: 'cover' }} />
                <div className="scan-reticle" />
              </div>
              <div className="row spread" style={{ margin: '8px 0' }}>
                <span className="small muted">Fill the box with the barcode. Hold steady.</span>
                {torch.available && <button className="btn ghost sm" onClick={toggleTorch}>{torch.on ? '🔦 On' : '🔦 Torch'}</button>}
              </div>
            </>}
        <button className="btn grey" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}
