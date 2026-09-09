const BASE = '/api';

async function req(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data.error || `Request failed (${r.status})`);
    err.code = data.code;
    err.data = data.data;
    throw err;
  }
  return data;
}

export const api = {
  riders: () => req('GET', '/riders'),
  login: (phone) => req('POST', '/login', { phone }),
  riderPPs: (phone) => req('GET', `/riders/${encodeURIComponent(phone)}/pps`),
  pp: (ppId) => req('GET', `/pps/${ppId}`),
  reach: (ppId) => req('POST', `/pps/${ppId}/reach`),
  scanRtoCrate: (ppId, crateId) => req('POST', `/pps/${ppId}/scan-rto-crate`, { crateId }),
  closeRto: (ppId) => req('POST', `/pps/${ppId}/close-rto`),
  scanEmptyCrate: (ppId, crateId) => req('POST', `/pps/${ppId}/scan-empty-crate`, { crateId }),
  closeEmpty: (ppId) => req('POST', `/pps/${ppId}/close-empty`),
  leave: (ppId) => req('POST', `/pps/${ppId}/leave`),
  scanEan: (crateId, skuId, ean, rider) => req('POST', `/crates/${crateId}/scan-ean`, { skuId, ean, rider }),
  closeSku: (ppId, skuId) => req('POST', `/pps/${ppId}/demand/${skuId}/close`),
  searchAdd: (crateId, skuId, query, rider) => req('POST', `/crates/${crateId}/skus/${skuId}/search-add`, { query, rider }),
  closeCrate: (crateId) => req('POST', `/crates/${crateId}/close`),
  pcRoster: () => req('GET', '/pc/roster'),
  pcLogin: (phone) => req('POST', '/pc/login', { phone }),
  pcInbound: (pc) => req('GET', `/pc/inbound?pc=${encodeURIComponent(pc)}`),
  pcReceive: (crateId, pc) => req('POST', '/pc/receive', { crateId, pc }),
  pcEndstate: (pc) => req('GET', `/pc/endstate?pc=${encodeURIComponent(pc)}`),
  clearance: () => req('GET', '/clearance'),
  clearCrate: (crateId) => req('POST', `/clearance/${crateId}/clear`),
  adminLogin: (email, code) => req('POST', '/admin/login', { email, code }),
};
