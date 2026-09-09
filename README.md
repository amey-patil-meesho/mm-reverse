# MM Reverse — RTO reverse-processing app (v2)

Streamlines reverse processing of RTO units at Pickup Points (PP). Replaces the old
"PP seals every crate" flow: crates are pre-created by the system, and the **MM rider**
does all scanning at the PP; a **PC operator** receives crates at the Processing Center.

Stack: **React (Vite)** + **Node/Express** + **SQLite** (Node 24 built-in `node:sqlite`,
no native build). The whole flow is a **server-authoritative state machine**, so the rider
only ever sees the actions valid for the current step (progressive disclosure).

## Deploy (single image → your phone over HTTPS)

Packaged as one **linux/amd64** image: the root `Dockerfile` builds the SPA and runs a single Node
process serving it **+ `/api` on port 9080** (no nginx, no native modules — `node:sqlite` is built in).
The deployed demo runs on the safe `backend/seed/sample_pp_pc.csv` seed; the real export with
`customer_id`s is `.dockerignore`d and never baked in. Admin on the deployed app is `amey.patil1@meesho.com`
+ `ADMIN_ACCESS_CODE` (baked as `mmreverse-admin` — rotate after judging).

Prereqs: **Docker Desktop running** and the **organizer registry token**. Then from this folder
(`D:\Buildathon\rto-reverse`), run the hackathon-deploy orchestrator:

```powershell
$env:HACKATHON_PROXY_TOKEN = "<registry token>"   # never commit / print
& "$env:USERPROFILE\.claude\plugins\cache\hackathon-plugins\hackathon-skills\0.1.0\skills\hackathon-deploy\scripts\deploy.ps1" -User amey.patil1@meesho.com
```

It builds → checks → zips → pushes → deploys, then prints the live link:
**`https://amey-patil1.buildathon.ltl.sh`** (HTTPS → the phone camera works). Give it a minute to come up.

To serve **live data** instead of the sample, pass `METABASE_API_KEY` (and the `GOOGLE_SA_*` / `GSHEET_ID`)
as deploy-time env on the container.

## Run locally

```bash
# terminal 1 — backend (http://localhost:8090)
cd backend && npm install && npm start

# terminal 2 — frontend (http://localhost:9080, proxies /api to 8090)
cd frontend && npm install && npm run dev
```

Open http://localhost:9080. Toggle **MM Rider** / **PC Receiving** at the top.
Reset demo data any time: `cd backend && npm run reset` then restart the server.

## The crate model

The forward leg drops crates at each PP daily. Units not delivered by `wh_date+2` are
auto-marked RTO on `wh_date+3`. So each day a PP has **"created" crates**: some carrying
RTO units, some fully-delivered (empty). RTO demand is tracked at **PP level**; the rider
**consolidates** the PP's RTO units into whichever available crates they scan, filling each
to capacity and overflowing to the next — which is why a 30-unit PP needs ≥2 crates.

A crate not picked within **`created_date + 4` days** is no longer eligible for pickup and
routes to the **Asset Clearance** flow instead.

## Rider flow (at the PP)

1. **Log in with your contact number** → see **only your tagged PPs**, sorted by total RTO units (prioritise under crunch).
2. **Reached at PP** → menu shows **Scan RTO Crate** / **Close all RTO crates** only.
3. **Scan RTO Crate** (an available, in-window crate) → the menu collapses to **Scan EAN** only.
   - Every scan field takes the **phone camera** (📷 button, ZXing, rear camera) or a typed/hardware-scanner value. Camera needs a secure context (HTTPS or localhost) + camera permission; it falls back to "type it instead" otherwise.
   - **Scan EAN** → the PP's RTO SKU list → open a SKU → scan every unit into the current crate.
     - A foreign EAN is rejected; SKU auto-closes when scanned == qty; short-close pops "*x units missing*".
     - **Wrong-SKU guard:** scanning another SKU's EAN here is rejected with *"that barcode is &lt;that SKU&gt; — scan it under &lt;that SKU&gt;"* and a **Go to &lt;that SKU&gt;** button.
     - **Can't scan / tarnished EAN → Identify the item** (inside the SKU): the rider types the in-hand item's **name or last 5 digits of its EAN**. The app resolves it against all of the PP's SKUs and **only counts it if it really is this SKU**; if it's a different SKU (e.g. *jeera 50g* while you're in *jeera 15g*) it refuses and points you to the correct SKU — preventing mis-assigned units.
   - The crate **closes** (finalised, ready for dispatch — **no seal**) when full ("*crate full, use a different crate*"), when all RTO units are packed, or via **Done — close this crate**. There is no seal step: accountability sits at the SKU scan, and any shortfall is debited at the PC.
4. Repeat with more crates for the remaining units, then **Close all RTO crates** (locks RTO; any unpacked units are recorded as short) → **Scan Empty Crate** → **Close all Empty Crates** → **Left PP** (PP leaves the list).

## Asset Clearance flow

Third tab. Lists every crate left unpicked past `created_date + 4`; a stale crate scanned
during pickup is rejected and shown here. **Mark cleared** writes it off.

## Handoff to tech — "Received at PC" CSV

The PC **Endstate** tab has **Download CSV** (also `GET /api/pc/endstate.csv`), the file tech
uses to mark crates **Received at Destination** so they re-enter normal reverse primary sorting.
SKU-wise grain: `wh_date, source_hub, destination_hub, crate_number, mm_rider, sku_id, units_received,
received_at, outcome`. Crates with packed units emit one row per SKU (`outcome=ELIGIBLE_FOR_RPS`);
empty/returned-empty crates emit one blank-SKU row (`outcome=UNBLOCKED`). This is the app's
only write back into the normal flow — the reverse primary sorting itself stays in the existing system.

### Google Sheet (auto, plus the raw rider scans)

When configured, the same handoff is written to a **Google Sheet** so tech can open/download it
without anyone exporting a file — two tabs:
- **Received at PC** — the SKU-wise received rows above (→ mark Received at Destination → RPS).
- **MM Rider Scans** — crate-level rider activity, stored separately: one row per crate the rider scanned (`scanned_at, mm_rider, source_hub, destination_hub, crate_number, crate_type, units_scanned, has_units, status, skus`). Shows **which crate was scanned and whether it carried units or was empty** (`has_units`), with a per-SKU `skus` breakdown — so it's never blank just because no EANs were scanned.

It syncs automatically after every PC receive, and via `POST /api/admin/sync-sheets` (admin-only). Config (env,
in `backend/.env`): a Google **service account** (`GOOGLE_SA_KEY_FILE` JSON, or `GOOGLE_SA_CLIENT_EMAIL`
+ `GOOGLE_SA_PRIVATE_KEY`) and `GSHEET_ID`; **share the sheet with the service account's email as
Editor**. Tab names override via `GSHEET_RECEIVED_TAB` / `GSHEET_SCANS_TAB`.

## Admin (data downloads are admin-only)

The **Admin** tab holds the data downloads (Received-at-PC CSV, MM-rider-scan CSV), a **live-counts
panel with a ↻ Refresh** (rider scan units, received/dispatched/pending crates), and ops
(Google-Sheet sync, Metabase refresh). PC receivers can no longer download raw data. Access:
- Log in with a **Meesho email** (`@meesho.com`, enforced) + an **access code**.
- The code is `ADMIN_ACCESS_CODE` (env). If unset, one is generated at boot and printed to the server log; **share it over mail with the authorised `@meesho.com` admins**. Optionally restrict to specific addresses with `ADMIN_EMAILS`.
- Downloads/ops require the code (`x-admin-code` header); the CSV endpoints `GET /api/pc/endstate.csv` and `GET /api/pc/rider-scans.csv` return `401` without it.

This is a lightweight shared-secret gate (the code is distributed over mail to Meesho people, and
the app enforces the `@meesho.com` domain) — not full SSO. Google-SSO-restricted-to-meesho.com or
email OTP can replace it later if stronger identity is needed.

## PC flow (at the Processing Center)

- **Login**: a PC receiver signs in with their contact number (one POC per PC / `destination_hub`); they only see crates inbound to **their** PC. Placeholder POC numbers per PC until a real mapping is supplied.
- **Inbound**: dispatched crates. Every crate is received with a **single crate scan** (no seal). Individual units are **not** scanned here — that happens during reverse primary sorting.
- On receive: a crate with **packed units** → **eligible for Reverse Primary Sorting**; an empty crate → **unblocked**. Received data is pushed to the Google Sheet (below); raw CSV downloads live in the admin-only **Admin** tab.
- **Endstate** tab = the `endstate_received_at_pc` table (handoff to the existing RPS flow, which is out of scope here).

## Data — the daily reverse-crate export

Seed file: `backend/seed/pp_pc_source.csv` — the operational reverse query export. Only
columns up to `rto_qty` are used. The importer (`db.js`) turns it into pending crates by:

1. Keep rows where `flow_direction = REVERSE` and `source_hub` is set (PP reverse rows; FM rows dropped).
2. **Crate-reuse dedup**: for each `crate_number`, keep only its **latest `wh_processing_date`** rows (a reused crate id means the earlier instance was physically picked, even if the system still shows it pending).
3. **Pending filter**: `created_at_source_timestamp` present **AND** `dispatched_from_source_timestamp` null **AND** `shipment_status ≠ TERMINAL` (TERMINAL = already at PC, unblocked from tech).
4. Column mapping: PP = `source_hub`, PC = `destination_hub`, crate = `crate_number`, SKU = `sku_id`, units = `rto_qty`, created date = `created_at_source_timestamp`.
5. A crate is **RTO** if its cumulative `rto_qty > 0`, else **empty**. RTO demand is aggregated to PP level across the PP's **eligible** RTO crates (stale ones go to clearance, not the pick list).

The CSV is a **fallback / offline seed**. In normal operation the app pulls the same query
directly from Metabase — no manual download/upload (see below).

## Automated pull from Metabase (no manual CSV)

The reverse-crate query (Metabase card `190711` on `metabase-main.bi.meeshogcp.in`, DB 9) has the
**same output columns as the CSV**, so pulled rows go through the identical pipeline. Configure via
env (copy `backend/.env.example` → `backend/.env`, gitignored):

- `METABASE_API_KEY` — a Metabase API key (Account settings → API keys). **Required** to pull; never committed. `METABASE_SESSION` (a raw session token) also works.
- `REFRESH_DAYS` (default 7) — trailing wh_date window pulled.
- `REFRESH_INTERVAL_MIN` (default 1440 in the example) — auto-refresh cadence; `0` = off.
- `STARTUP_PULL_MODE` — `merge` (default, additive/safe) or `rebuild` (wipe + reload).
- `NODE_EXTRA_CA_CERTS` — set to `../corporate-ca.crt` if Node rejects the TLS cert behind the Netskope proxy.

With a key set, the server **pulls on boot and then every `REFRESH_INTERVAL_MIN`**. You can also trigger it:
`POST /api/admin/refresh {whStart?, whEnd?, mode?}`, check config with `GET /api/admin/data-source`,
or run a one-off: `cd backend && METABASE_API_KEY=… npm run pull -- 2026-09-01 2026-09-08 rebuild`.

**merge vs rebuild:** `merge` (used for live refreshes) only adds *newly-appeared* pending crates —
it never touches crates the app is already processing, in-progress PP sessions, or the received-at-PC
endstate. `rebuild` wipes and reloads (initial load / full reset). Without any Metabase env, the app
just loads the CSV seed and runs fully offline.

**Login:** the rider signs in with their contact number (`POST /api/login`); no OTP/auth yet.
Until the real MM-rider→PP mapping is supplied, **every PP is tagged to one owner — `Amey` /
`9999999999`** — so that login sees all pending PPs (override with `RIDER_NAME` / `RIDER_PHONE`
env). The unit scan code is `sku_id` (`ean` = `sku_id`) until an EAN column/master is provided.

Crate capacity is a server config: `CRATE_CAPACITY` env (default 25), counted in **units**
now and structured (`unitLoad()` in logic.js) to become volume/weight-based per SKU later.
`CLEARANCE_DAYS` (default 4) and `DEMO_DATE` (pin "today" for demos) are env-configurable.
A load-time guard warns if any PP has more RTO units than its crates can hold.

## Layout

- `backend/src/db.js` — schema, CSV load, derive PP-level demand + crates from the seed, capacity guard.
- `backend/src/logic.js` — the state machine: transitions, consolidation scan rules, eligibility, progressive-disclosure `actions`.
- `backend/src/server.js` — REST API under `/api`.
- `frontend/src/rider.jsx` — rider screens; `frontend/src/pc.jsx` — PC receiving; `frontend/src/clearance.jsx` — asset clearance.
