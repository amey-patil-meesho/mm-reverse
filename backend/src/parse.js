// Parse an uploaded workbook (.xlsx/.csv) into an ingest payload — the fallback data path when the
// Google Sheets bridge isn't used. It classifies each worksheet by its columns (same idea as the
// Apps Script gateway): a rider-crate sheet, the EAN-SKU master, a shop-name/route sheet, or the
// rider directory (phone lookup). Robust to header spelling via fuzzy matching.
import * as XLSX from 'xlsx';

const norm = (s) => String(s ?? '').trim().toLowerCase();
const digits10 = (v) => { const d = String(v ?? '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : d; };

// header row -> { lowercased header: index }
function cols(headerRow = []) {
  const m = {};
  headerRow.forEach((h, i) => { const k = norm(h); if (k && !(k in m)) m[k] = i; });
  return m;
}
// exact match then "contains"
function pick(map, candidates) {
  for (const c of candidates) if (map[c] != null) return map[c];
  const keys = Object.keys(map);
  for (const c of candidates) for (const k of keys) if (k.includes(c)) return map[k];
  return -1;
}
const val = (row, i) => (i >= 0 && row[i] != null ? String(row[i]).trim() : '');

export function parseWorkbook(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const sheets = wb.SheetNames.map((name) => ({
    name,
    grid: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false, defval: '' }),
  })).filter((s) => s.grid.length >= 2);

  const dirByRoute = new Map();   // route(lower) -> { phone, name }
  const dirByName = new Map();    // name(lower)  -> phone
  const shops = new Map();        // pp_code -> shop name
  const skus = [];
  const dataSheets = [];          // { headerMap, rows }

  for (const { grid } of sheets) {
    const H = cols(grid[0]);
    const cCrate = pick(H, ['crate_number', 'crate number', 'crate']);
    const cPP = pick(H, ['source_hub', 'pp code', 'pp_code', 'source hub', 'pp']);
    const cSkuId = pick(H, ['sku_id', 'sku id', 'sku']);
    const cEan = pick(H, ['ean', 'barcode']);
    const cSkuName = pick(H, ['sku_name', 'item name', 'product', 'description', 'name']);
    const cShop = pick(H, ['shop name', 'shop_name', 'store name', 'shop']);
    const cPhone = pick(H, ['rider number', 'phone', 'contact', 'number', 'mobile']);
    const cRoute = pick(H, ['route no', 'route', 'route no.']);

    // 1) rider-crate sheet (strongest signal: has a crate column + a PP column)
    if (cCrate >= 0 && cPP >= 0) { dataSheets.push({ H, rows: grid.slice(1) }); continue; }
    // 2) EAN-SKU master — only APPROVED EANs are usable
    if (cSkuId >= 0 && (cEan >= 0 || cSkuName >= 0)) {
      const cStatus = pick(H, ['status', 'ean status', 'approval status', 'approval']);
      for (const r of grid.slice(1)) {
        const id = val(r, cSkuId); if (!id) continue;
        if (cStatus >= 0 && val(r, cStatus).toUpperCase() !== 'APPROVED') continue;
        skus.push({ sku_id: id, ean: val(r, cEan), sku_name: cSkuName >= 0 ? val(r, cSkuName) : '' });
      }
      continue;
    }
    // 3) shop-name / route stop list
    if (cPP >= 0 && cShop >= 0) {
      for (const r of grid.slice(1)) { const pp = val(r, cPP); if (pp && !shops.has(pp)) shops.set(pp, val(r, cShop)); }
      continue;
    }
    // 4) rider directory (phone lookup)
    if (cPhone >= 0 && (cRoute >= 0 || pick(H, ['rider name', 'name']) >= 0)) {
      const cName = pick(H, ['rider name', 'name']);
      for (const r of grid.slice(1)) {
        const phone = digits10(val(r, cPhone)); if (!phone) continue;
        const name = cName >= 0 ? val(r, cName) : '';
        const route = cRoute >= 0 ? val(r, cRoute) : '';
        if (route) dirByRoute.set(norm(route), { phone, name });
        if (name) dirByName.set(norm(name), phone);
      }
    }
  }

  // Build ingest rows from the rider-crate sheets, resolving each row's rider phone.
  const rows = [];
  for (const { H, rows: rs } of dataSheets) {
    const cCrate = pick(H, ['crate_number', 'crate number', 'crate']);
    const cPP = pick(H, ['source_hub', 'pp code', 'pp_code', 'source hub', 'pp']);
    const cSku = pick(H, ['sku_id', 'sku id', 'sku']);
    const cRto = pick(H, ['rto_qty', 'rto qty', 'rto']);
    const cDest = pick(H, ['destination_hub', 'destination hub', 'pc']);
    const cWh = pick(H, ['wh_processing_date', 'wh date', 'wh_date']);
    const cCreated = pick(H, ['created_at_source_timestamp', 'created_at', 'created']);
    const cRoute = pick(H, ['rider route', 'route no', 'route']);
    const cRname = pick(H, ['rider name']);   // NOT bare 'rider' — that would catch "Rider Route"
    const cPhoneCol = pick(H, ['rider number', 'rider phone', 'phone', 'contact']);

    for (const r of rs) {
      const crate = val(r, cCrate); const pp = val(r, cPP);
      if (!crate || !pp) continue;
      const route = cRoute >= 0 ? val(r, cRoute) : '';
      const rname = cRname >= 0 ? val(r, cRname) : '';
      let phone = cPhoneCol >= 0 ? digits10(val(r, cPhoneCol)) : '';
      let name = rname;
      const byRoute = route && dirByRoute.get(norm(route));
      if (!phone && byRoute) { phone = byRoute.phone; name = name || byRoute.name; }
      if (!phone && rname && dirByName.get(norm(rname))) phone = dirByName.get(norm(rname));
      rows.push({
        rider_phone: phone, rider_name: name || route,
        pp_code: pp, shop_name: shops.get(pp) || '',
        pc: cDest >= 0 ? val(r, cDest) : '',
        crate_id: crate, sku_id: cSku >= 0 ? val(r, cSku) : '',
        rto_qty: cRto >= 0 ? Number(val(r, cRto) || 0) : 0,
        wh_date: cWh >= 0 ? val(r, cWh) : '', created: cCreated >= 0 ? val(r, cCreated) : '',
      });
    }
  }

  const unresolved = rows.filter((r) => !r.rider_phone).length;
  return { skus, rows, stats: { sheets: sheets.length, data_rows: rows.length, riders: dirByRoute.size || dirByName.size, unresolved } };
}
