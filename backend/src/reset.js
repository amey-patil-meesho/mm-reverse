// Wipe the SQLite DB so the next server start re-seeds from the CSV. Run: npm run reset
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');
for (const f of ['mm_reverse.db', 'mm_reverse.db-wal', 'mm_reverse.db-shm']) {
  const p = path.join(dataDir, f);
  if (fs.existsSync(p)) { fs.rmSync(p); console.log('removed', f); }
}
console.log('DB reset. Start the server to re-seed from seed/rto_source.csv');
