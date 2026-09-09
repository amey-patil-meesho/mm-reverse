// Manual one-off pull from Metabase. Usage:
//   METABASE_API_KEY=... node src/pull.js [wh_start] [wh_end] [merge|rebuild]
// Defaults to the last REFRESH_DAYS (7) window and rebuild.
import { initDb } from './db.js';
import { pullAndLoad, metabaseConfigured, defaultWindow } from './metabase.js';

initDb();
if (!metabaseConfigured()) {
  console.error('Set METABASE_API_KEY (or METABASE_SESSION) first.');
  process.exit(1);
}
const [, , start, end, mode] = process.argv;
const win = start && end ? { whStart: start, whEnd: end } : defaultWindow();
pullAndLoad({ ...win, mode: mode || 'rebuild' })
  .then((r) => { console.log('pull result:', JSON.stringify(r, null, 2)); process.exit(0); })
  .catch((e) => { console.error('pull failed:', e.message); process.exit(1); });
