# Build brief: "MM Reverse" — reverse/RTO crate-pickup app for MM riders

Build a mobile-first web app for Meesho **MM (last-mile) riders** to process **reverse / RTO
(Return-to-Origin) crates** at **Pickup Points (PPs)**. Riders scan crates and units on their
phones. **All data lives in Google Sheets** (input and output) — there is **no database**.
Deploy on **Vercel**, with a **Google Apps Script** web app as the gateway to the Sheets.

Keep it beginner-friendly and mobile-first. Stack: **React (Vite) SPA**, a thin **Node serverless
function** on Vercel, **Google Apps Script** for all Sheet access, **ZXing** for camera barcode
scanning. No SQL database.

## Users
- **MM Rider** (primary): logs in with their phone number; scans crates/units at their PPs.
- **Admin** (a colleague/manager): logs in with a Meesho email (`@meesho.com` enforced) + a shared
  access code; can download the scan data. Keep admin behind that gate.

## Data model — Google Sheets are the single source of truth
- **Master sheet** (a directory): one row per eligible rider, with columns for **rider name**,
  **phone number** (used for login), and a **link/ID to that rider's own spreadsheet**.
- **Each rider's spreadsheet**: **one tab per date**, named as a sortable date (e.g. `2026-09-09`).
  Each date tab holds that rider's pending reverse crates for that day, **pre-filled by the ops team**.
- **Input columns** (one row per **crate × SKU**): warehouse date, PP code, destination PC,
  `crate_number`, `sku_id`, sku name & EAN (if available), `rto_qty` (units to pick), created
  timestamp. An **empty crate** is a row with `rto_qty = 0` / blank SKU.
- **Output columns the app fills** as the rider scans (same rows): `units_scanned`,
  `scanned_at_pp` (timestamp when that row's units are fully scanned), `status`
  (done / short / empty), optional `left_pp_at`. So the sheet shows **expected vs actually scanned**.

## Login flow
Rider enters phone number → gateway looks it up in the **Master sheet** → opens that rider's
spreadsheet → selects the **latest date tab** → returns that day's crates. (Data is ready before
login because the ops team pre-fills the sheets.)

## Rider flow & rules (the core logic — implement precisely)
1. After login, show the rider's **PPs** (grouped from the day's rows), **sorted by total RTO units
   descending** (busiest first); each PP shows its total RTO units.
2. Tap a PP → **"Reached at PP."** Use **progressive disclosure**: at every step show only the
   actions valid right now.
3. **RTO crates:** **Scan RTO Crate** → scan/bind a crate → show the PP's RTO **SKU demand list**
   (each SKU + qty) → tap a SKU → **scan each unit's EAN**:
   - A **foreign EAN is rejected**; if that barcode belongs to another SKU at the PP, tell the rider
     *which* SKU and offer a "Go to <that SKU>" jump (don't mis-assign).
   - A SKU **auto-closes** when scanned == expected; short-closing records the missing count.
   - **Crate capacity** is a unit limit (e.g. 25). When a crate fills, **auto-close it**
     ("crate full — use a different crate") and overflow to the next crate.
   - **Search SKU INSIDE each SKU** (for a tarnished/unscannable barcode): the rider types the
     in-hand item's **name or last 5 digits of its EAN**; resolve it against **all** the PP's SKUs
     and **only count it if it is the current SKU** — otherwise refuse and point to the correct SKU
     (e.g. *jeera 15g* vs *jeera 50g* have different EANs; entering 50g's last-5 while inside 15g
     must error "that's jeera 50g, add it under jeera 50g"). This prevents mis-assigned units.
   - **Close a crate** → finalised. **No seal step** — accountability is at the SKU scan; shortfalls
     are debited downstream.
4. **Close all RTO crates** → locks RTO for the PP; any unpacked units are recorded as short.
5. **Empty crates:** **Scan Empty Crate** (no units, no seal). Crates with 0 RTO are empties; an RTO
   crate the rider never packed into also becomes an empty to return.
6. **Close all Empty Crates** → **Left PP** → the PP is done and drops off the list.
7. **Camera-first**: every scan field uses the **phone camera** (ZXing barcode scanner, rear camera)
   or a typed/hardware-scanner value, with a graceful "type it instead" fallback when the camera is
   unavailable.

## Writing results back
As the rider scans, fill the **output columns** on the matching rows in that day's tab. **Batch the
writes** (on crate-close / Left-PP), not on every tap, to stay within Google Sheets write limits.
Pending on a re-login = rows without `scanned_at_pp`.

## Architecture (Apps Script + Vercel, stateless, no DB)
- **Google Apps Script web app** (deployed by the sheet owner, "execute as me") is the **gateway**:
  it reads the Master, opens rider sheets by ID (it can access all the owner's sheets), returns the
  latest date tab on login, and writes scan output back. Protect it with a **shared secret token**.
  Expose `doGet`/`doPost` actions: `login` (phone → that rider's day data) and `submit` (write scan
  results back to the rows).
- **Vercel** hosts the **React SPA (static)** plus a **thin serverless proxy** that forwards to the
  Apps Script URL and holds the token **server-side** (so it isn't exposed in the browser).
- Because the Sheets hold the state and the **phone holds the in-progress scan during a PP**, the
  backend is **stateless** (Vercel-friendly). Known trade-off: **no cross-device resume** — if a
  rider closes the app mid-PP, that PP's in-progress counts are lost and re-scanned.
- Client-side validation is fine (it's an internal tool): foreign-EAN, wrong-SKU, and capacity
  checks run on the phone against the loaded SKU list; the sheet is the record.

## Admin
Login = a Meesho email (`@meesho.com` enforced, optional allowlist) + a shared **access code** (env
var). Admin can **download the rider scan data** (CSV) and see live counts. No raw downloads for
riders.

## Deployment steps (summary)
1. Create the **Master** sheet + a **spreadsheet per rider** (date tabs), pre-filled by ops.
2. In the Master (or a standalone script): **Extensions → Apps Script** → paste the gateway script →
   **Deploy → Web app** (execute as you, access "Anyone") → authorize → copy the **Web App URL**.
3. On **Vercel**: import the repo, set env vars — `APPS_SCRIPT_URL`, `APPS_SCRIPT_TOKEN`,
   `ADMIN_EMAILS`, `ADMIN_ACCESS_CODE` — and deploy (`vercel --prod`).
4. Open the URL on a phone → **Add to Home Screen** (PWA-style, full-screen, camera works over HTTPS).

## Notes for extension
This is the base flow; the colleague wants to add features on top — keep the code modular (separate
the Sheet gateway, the rider flow, and the admin area) so new steps, columns, or roles are easy to
add. Ask the user for their specific additions and the exact Master/rider-sheet column headers
before wiring the gateway.
