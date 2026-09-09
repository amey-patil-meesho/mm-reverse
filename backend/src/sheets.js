import crypto from 'node:crypto';
import fs from 'node:fs';
import { pcEndstateRows, RECEIVED_COLS, riderScanRows, SCAN_COLS } from './logic.js';

// Writes received-at-PC data to a Google Sheet (tab 1) and the raw MM-rider scan data to a
// separate sub-sheet (tab 2), so tech can download a CSV to unblock for reverse primary sorting.
// Auth is a Google service account (JWT → OAuth token), configured via env — no secret in code.
// If unconfigured, every call is a no-op and the app still serves the same data as CSV endpoints.

const RECEIVED_TAB = process.env.GSHEET_RECEIVED_TAB || 'Received at PC';
const SCANS_TAB = process.env.GSHEET_SCANS_TAB || 'MM Rider Scans';
const SHEET_ID = () => process.env.GSHEET_ID;

function creds() {
  let email = process.env.GOOGLE_SA_CLIENT_EMAIL;
  let key = process.env.GOOGLE_SA_PRIVATE_KEY;
  if ((!email || !key) && process.env.GOOGLE_SA_KEY_FILE && fs.existsSync(process.env.GOOGLE_SA_KEY_FILE)) {
    const j = JSON.parse(fs.readFileSync(process.env.GOOGLE_SA_KEY_FILE, 'utf8'));
    email = email || j.client_email;
    key = key || j.private_key;
  }
  if (key) key = key.replace(/\\n/g, '\n');   // env-encoded newlines
  return { email, key };
}
export const sheetsConfigured = () => { const c = creds(); return !!(c.email && c.key && SHEET_ID()); };

const b64url = (s) => Buffer.from(s).toString('base64url');

async function getToken() {
  const { email, key } = creds();
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: email, scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`); signer.end();
  const jwt = `${header}.${claim}.${b64url(signer.sign(key))}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  if (!res.ok) throw new Error(`Google token failed: HTTP ${res.status} — ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).access_token;
}

async function api(token, method, suffix, body) {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID()}${suffix}`, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Sheets ${method} ${suffix} → HTTP ${res.status} — ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function ensureTabs(token) {
  const meta = await api(token, 'GET', '');
  const have = new Set((meta.sheets || []).map((s) => s.properties.title));
  const missing = [RECEIVED_TAB, SCANS_TAB].filter((t) => !have.has(t));
  if (missing.length) await api(token, 'POST', ':batchUpdate', { requests: missing.map((title) => ({ addSheet: { properties: { title } } })) });
}

const grid = (cols, rows) => [cols, ...rows.map((r) => cols.map((c) => (r[c] == null ? '' : r[c])))];
const writeTab = async (token, tab, values) => {
  await api(token, 'POST', `/values/${encodeURIComponent(tab)}:clear`, {});
  await api(token, 'PUT', `/values/${encodeURIComponent(`${tab}!A1`)}?valueInputOption=RAW`, { values });
};

// Full snapshot sync (clear + rewrite both tabs). Coalesces concurrent calls.
let running = false, pending = false;
export async function syncSheets() {
  if (!sheetsConfigured()) return { skipped: 'sheets not configured' };
  if (running) { pending = true; return { coalesced: true }; }
  running = true;
  try {
    const token = await getToken();
    await ensureTabs(token);
    const received = grid(RECEIVED_COLS, pcEndstateRows());
    const scans = grid(SCAN_COLS, riderScanRows());
    await writeTab(token, RECEIVED_TAB, received);
    await writeTab(token, SCANS_TAB, scans);
    return { received_rows: received.length - 1, scan_rows: scans.length - 1 };
  } finally {
    running = false;
    if (pending) { pending = false; syncSheets().catch((e) => console.warn('[sheets] resync failed:', e.message)); }
  }
}

// Fire-and-forget (used right after a PC receive) so the response isn't blocked on Google.
export function syncSheetsAsync() {
  if (!sheetsConfigured()) return;
  syncSheets().then((r) => console.log('[sheets] synced:', JSON.stringify(r))).catch((e) => console.warn('[sheets] sync failed:', e.message));
}
