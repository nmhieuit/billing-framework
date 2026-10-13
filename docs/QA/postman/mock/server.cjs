// Mock tối giản của wallet (3001) và payment (3002), viết theo cách đọc code. CHỈ để chạy thử luồng Postman/Newman;
// KHÔNG thay thế việc chạy service thật.
const http = require('http'); const crypto = require('crypto');
const SECRET = process.env.WEBHOOK_SECRET || 'local-only-webhook-secret';
const TENANTS = ['acme', 'beta'];
const RESP_TIMEOUT = parseInt(process.env.RESPONSE_TIMEOUT_MS || '2000', 10);
const now = () => new Date();
const uid = (p) => p + crypto.randomBytes(8).toString('hex');
// ---------- stores ----------
const W = { wallets: new Map(), topups: new Map(), topupKeys: new Map(), entries: new Map(), txs: new Map(), inbox: new Set(), ops: [], opsKeys: new Map(), runs: new Map(), items: new Map(), seq: 0, opsSeq: 0, itemSeq: 0 };
const P = { charges: new Map(), keys: new Map(), seq: 0 };
const ENTRY = (t, c) => { const k = t + '|' + c; if (!W.entries.has(k)) W.entries.set(k, []); return W.entries.get(k); };
class HttpErr extends Error { constructor(s, c, m) { super(m || c); this.status = s; this.code = c; } }
const send = (res, status, body) => { const s = body === undefined ? '' : JSON.stringify(body); res.writeHead(status, { 'content-type': 'application/json' }); res.end(s); };
function readBody(req) { return new Promise((r) => { const ch = []; req.on('data', (d) => ch.push(d)); req.on('end', () => r(Buffer.concat(ch).toString('utf8'))); }); }
function parseJson(raw) { if (raw === '') return undefined; try { return JSON.parse(raw); } catch { throw new HttpErr(400, 'INVALID_REQUEST', 'invalid JSON'); } }
const hv = (req, k) => { const v = req.headers[k]; return Array.isArray(v) ? v.join(',') : v; };
const isObj = (b) => typeof b === 'object' && b !== null && !Array.isArray(b);
const CUST = /^[A-Za-z0-9_-]{1,64}$/; const TEN = /^[a-z][a-z0-9-]{0,39}$/;
function tenantOf(raw) { if (raw === undefined || raw.trim() === '') throw new HttpErr(400, 'MISSING_TENANT'); if (!TEN.test(raw) || !TENANTS.includes(raw)) throw new HttpErr(403, 'UNKNOWN_TENANT'); return raw; }
function money(amount, cur) { if (!Number.isSafeInteger(amount)) throw new HttpErr(400, 'INVALID_REQUEST', 'amount must be a safe integer'); if (!['VND', 'USD'].includes(cur)) throw new HttpErr(400, 'INVALID_REQUEST', 'unsupported currency'); }
function query(url) { const u = new URL(url, 'http://x'); const m = {}; for (const [k, v] of u.searchParams) { (m[k] = m[k] || []).push(v); } return { path: u.pathname, q: m }; }
function single(q, k) { if (!q[k]) return undefined; if (q[k].length > 1) throw new HttpErr(400, 'INVALID_QUERY', k + ' repeated'); return q[k][0]; }
function wallet(t, c) { return W.wallets.get(t + '|' + c); }
const view = (w) => ({ customerId: w.customerId, currency: w.currency, balance: w.balance, createdAt: w.createdAt });
function post(t, c, kind, bkey, amount) { const tx = uid('tx_'); W.txs.set(t + '|' + tx, { id: tx, kind, bkey, customer: c, amount, reversed: false, tenant: t }); const e = ENTRY(t, c); e.push({ entryId: ++W.seq, transactionId: tx, businessKey: bkey, amount, createdAt: now().toISOString() }); return tx; }
// ---------- payment domain ----------
function parseScenario(h) {
  const sc = { fail: null, delay: null, webhook: 'normal', timeout: false };
  if (h === undefined || h.trim() === '') return sc; const seen = new Set();
  for (const raw of h.split(',')) { const tk = raw.trim(); const eq = tk.indexOf('='); if (eq <= 0 || eq === tk.length - 1) throw new HttpErr(400, 'INVALID_SIMULATE'); const k = tk.slice(0, eq).trim(); const v = tk.slice(eq + 1).trim(); if (seen.has(k)) throw new HttpErr(400, 'INVALID_SIMULATE'); seen.add(k);
    if (k === 'fail') { if (!/^[a-z][a-z0-9_]{0,63}$/.test(v)) throw new HttpErr(400, 'INVALID_SIMULATE'); sc.fail = v; }
    else if (k === 'delay') { if (!/^[1-9][0-9]{0,3}$/.test(v) || Number(v) > 3600) throw new HttpErr(400, 'INVALID_SIMULATE'); sc.delay = Number(v); }
    else if (k === 'webhook') { if (v !== 'drop' && v !== 'duplicate') throw new HttpErr(400, 'INVALID_SIMULATE'); sc.webhook = v; }
    else if (k === 'response') { if (v !== 'timeout') throw new HttpErr(400, 'INVALID_SIMULATE'); sc.timeout = true; }
    else throw new HttpErr(400, 'INVALID_SIMULATE'); }
  return sc;
}
function parseMetadata(raw) {
  if (raw === undefined) return {}; if (!isObj(raw)) throw new HttpErr(400, 'INVALID_REQUEST'); const e = Object.entries(raw); if (e.length > 10) throw new HttpErr(400, 'INVALID_REQUEST');
  const out = {}; for (const [k, v] of e.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) { if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(k)) throw new HttpErr(400, 'INVALID_REQUEST'); if (typeof v !== 'string' || v.length > 200) throw new HttpErr(400, 'INVALID_REQUEST'); out[k] = v; } return out;
}
function createCharge({ key, amount, currency, reference, metadata, simulate }) {
  const sc = parseScenario(simulate); money(amount, currency); const md = parseMetadata(metadata);
  if (reference.trim().length === 0 || reference.length > 200) throw new HttpErr(400, 'INVALID_REQUEST', 'reference');
  if (amount < 1) throw new HttpErr(400, 'INVALID_REQUEST', 'amount');
  const hash = JSON.stringify({ amount, currency, reference, sc, md: Object.keys(md).length ? md : undefined });
  const ex = P.keys.get(key); if (ex) { if (ex.hash !== hash) throw new HttpErr(422, 'IDEMPOTENCY_KEY_REUSED'); return { status: 202, body: ex.body, replayed: true, sc }; }
  const id = uid('ch_'); const c = { chargeId: id, reference, amount, currency, status: 'PENDING', failureCode: null, sc, metadata: md, dueAt: Date.now() + (sc.delay || 0) * 1000, createdAt: now().toISOString(), completedAt: null, seq: ++P.seq };
  P.charges.set(id, c); const body = { chargeId: id, reference, amount, currency, status: 'PENDING', ...(Object.keys(md).length ? { metadata: md } : {}), createdAt: c.createdAt };
  P.keys.set(key, { hash, body }); return { status: 202, body, replayed: false, sc };
}
const chargeView = (c) => ({ chargeId: c.chargeId, reference: c.reference, amount: c.amount, currency: c.currency, status: c.status, ...(c.failureCode ? { failureCode: c.failureCode } : {}), ...(Object.keys(c.metadata).length ? { metadata: c.metadata } : {}), createdAt: c.createdAt, ...(c.completedAt ? { completedAt: c.completedAt } : {}) });
setInterval(() => { for (const c of P.charges.values()) { if (BUG() === 'stuck' && c.reference.startsWith('tp_')) continue; if (c.status === 'PENDING' && c.dueAt <= Date.now()) { c.status = c.sc.fail ? 'FAILED' : 'SUCCEEDED'; c.failureCode = c.sc.fail; c.completedAt = now().toISOString(); deliver(c); } } }, 100);
function deliver(c) {
  if (c.sc.webhook === 'drop') return;
  const type = c.status === 'SUCCEEDED' ? 'charge.succeeded' : 'charge.failed';
  const ev = { eventId: uid('evt_'), type, createdAt: now().toISOString(), data: { chargeId: c.chargeId, reference: c.reference, amount: c.amount, currency: c.currency, status: c.status, completedAt: c.completedAt, ...(c.failureCode ? { failureCode: c.failureCode } : {}), ...(Object.keys(c.metadata).length ? { metadata: c.metadata } : {}) } };
  const n = c.sc.webhook === 'duplicate' ? 2 : 1; for (let i = 0; i < n; i++) { try { applyWebhook(ev); } catch { /* wallet từ chối (vd thiếu tenantId): payment sẽ retry thật; mock bỏ qua */ } }
  if (BUG() === 'double_credit') { try { applyWebhook({ ...ev, eventId: uid('evt_') }); } catch { /* bỏ qua */ } }
}
// ---------- wallet webhook ----------
function validateWebhook(p) {
  const err = (m) => { throw new HttpErr(400, 'INVALID_WEBHOOK', m); };
  if (!isObj(p)) err('object'); for (const k of ['eventId', 'type', 'createdAt', 'data']) if (!(k in p)) err('missing ' + k);
  if (typeof p.eventId !== 'string' || p.eventId === '') err('eventId'); if (!['charge.succeeded', 'charge.failed'].includes(p.type)) err('type');
  const d = p.data; if (!isObj(d)) err('data'); for (const k of ['chargeId', 'reference', 'amount', 'currency', 'status', 'completedAt']) if (!(k in d)) err('missing ' + k);
  if (typeof d.chargeId !== 'string' || !d.chargeId || typeof d.reference !== 'string' || !d.reference) err('ids'); if (!Number.isInteger(d.amount) || d.amount < 1) err('amount');
  if (!['VND', 'USD'].includes(d.currency)) err('currency'); if (!['SUCCEEDED', 'FAILED'].includes(d.status)) err('status');
  if (d.failureCode !== undefined && !/^[a-z][a-z0-9_]{0,63}$/.test(d.failureCode)) err('failureCode');
  if (d.metadata !== undefined) { if (!isObj(d.metadata) || Object.keys(d.metadata).length > 10) err('metadata'); }
  if (p.type === 'charge.succeeded') { if (d.status !== 'SUCCEEDED' || d.failureCode !== undefined) err('succeeded'); } else { if (d.status !== 'FAILED' || d.failureCode === undefined) err('failed'); }
  return p;
}
function applyWebhook(p) {
  const d = p.data; const t = d.metadata && d.metadata.tenantId; if (!t || !TENANTS.includes(t)) throw new HttpErr(400, 'INVALID_WEBHOOK', 'tenant');
  const ik = t + '|' + p.eventId; if (W.inbox.has(ik)) return 'DUPLICATE'; W.inbox.add(ik);
  const tp = W.topups.get(t + '|' + d.reference); if (!tp) return 'UNKNOWN_TOPUP';
  if (!(tp.amount === d.amount && tp.currency === d.currency && (tp.chargeId === null || tp.chargeId === d.chargeId))) return 'MISMATCH';
  if (p.type === 'charge.succeeded') {
    const late = tp.status === 'FAILED' && tp.failureCode === 'PAYMENT_UNAVAILABLE';
    if (!['REQUESTED', 'PENDING'].includes(tp.status) && !late && !(BUG() === 'double_credit' && tp.status === 'SUCCEEDED')) return 'IGNORED';
    tp.status = 'SUCCEEDED'; tp.chargeId = d.chargeId; tp.failureCode = null; tp.completedAt = now().toISOString();
    const w = wallet(t, tp.customerId); w.balance += tp.amount; if (BUG() !== 'lost_entry') post(t, tp.customerId, 'TOPUP', 'topup:' + tp.id, tp.amount); return 'APPLIED';
  }
  if (!['REQUESTED', 'PENDING'].includes(tp.status)) return 'IGNORED'; tp.status = 'FAILED'; tp.chargeId = d.chargeId; tp.failureCode = d.failureCode; tp.completedAt = now().toISOString(); return 'APPLIED';
}
function verifySig(raw, header) {
  const m = {}; for (const part of (header || '').split(',')) { const i = part.indexOf('='); if (i > 0) m[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
  if (!/^\d{1,12}$/.test(m.t || '') || !/^[0-9a-f]{64}$/i.test(m.v1 || '')) return false;
  const exp = crypto.createHmac('sha256', SECRET).update(m.t + '.' + raw).digest(); const act = Buffer.from(m.v1, 'hex'); if (!crypto.timingSafeEqual(act, exp)) return false;
  return Math.abs(Math.floor(Date.now() / 1000) - Number(m.t)) <= 300;
}
// ---------- wallet handlers ----------
function caller(req) { const t = tenantOf(hv(req, 'x-tenant-id')); const c = hv(req, 'x-customer-id'); if (c === undefined || c.trim() === '') throw new HttpErr(400, 'MISSING_CUSTOMER'); if (!CUST.test(c)) throw new HttpErr(400, 'INVALID_REQUEST', 'customer'); return { t, c }; }
function opsGuard(req) { const a = (hv(req, 'x-actor-id') || '').trim(); if (!a) throw new HttpErr(401, 'MISSING_ACTOR'); if ((hv(req, 'x-actor-role') || '').trim() !== 'OPS') throw new HttpErr(403, 'FORBIDDEN_ROLE'); return { t: tenantOf(hv(req, 'x-tenant-id')), actor: a }; }
const text = (v) => (typeof v === 'string' ? v : '');
function opsCommon(body, actor) { const reason = text(body.reason).trim(); const key = text(body.idempotencyKey).trim(); if (reason.length < 1 || reason.length > 500) throw new HttpErr(422, 'INVALID_OPS_REQUEST'); if (key.length < 1 || key.length > 200) throw new HttpErr(422, 'INVALID_OPS_REQUEST'); return { reason, key, actor }; }
const BUG = () => process.env.MOCK_BUG || '';
function opsRun(t, key, fp, action, target, actor, reason, fn) {
  const k = t + '|' + key; const ex = W.opsKeys.get(k); if (ex) { if (ex.fp !== fp) throw new HttpErr(409, 'IDEMPOTENCY_CONFLICT'); if (BUG() === 'dup_adjust') fn(uid('act_')); return ex.result; }
  const actionId = uid('act_'); const out = fn(actionId); if (out.noop) return out.result;
  const result = { ...out.result, actionId }; W.ops.push({ seq: ++W.opsSeq, tenant: t, id: actionId, action, actor, reason, target, createdAt: now().toISOString() }); W.opsKeys.set(k, { fp, result }); return result;
}
async function walletHandler(req, res, raw) {
  const { path, q } = query(req.url); const m = req.method; const seg = path.split('/').filter(Boolean);
  if (m === 'GET' && path === '/health') return send(res, 200, { status: 'ok', service: 'wallet' });
  if (path === '/webhooks/payment' && m === 'POST') {
    if (!verifySig(raw, hv(req, 'x-signature'))) throw new HttpErr(401, 'INVALID_SIGNATURE'); let body; try { body = JSON.parse(raw); } catch { throw new HttpErr(400, 'INVALID_WEBHOOK', 'json'); }
    validateWebhook(body); return send(res, 200, { outcome: applyWebhook(body) });
  }
  if (seg[0] === 'ops') return opsHandler(req, res, raw, seg, m, q);
  if (seg[0] === 'reconciliations' || seg[0] === 'reconciliation-items') return reconHandler(req, res, raw, seg, m, q);
  const { t, c } = caller(req);
  if (path === '/wallets' && m === 'POST') { const b = parseJson(raw); if (!isObj(b)) throw new HttpErr(400, 'INVALID_REQUEST'); if (typeof b.currency !== 'string') throw new HttpErr(400, 'INVALID_REQUEST'); money(0, b.currency);
    const ex = wallet(t, c); if (ex) { if (ex.currency !== b.currency) throw new HttpErr(409, 'WALLET_CURRENCY_CONFLICT'); return send(res, 200, view(ex)); }
    const w = { customerId: c, currency: b.currency, balance: 0, createdAt: now().toISOString(), frozen: false }; W.wallets.set(t + '|' + c, w); return send(res, 201, view(w)); }
  if (path === '/wallet' && m === 'GET') { const w = wallet(t, c); if (!w) throw new HttpErr(404, 'WALLET_NOT_FOUND'); return send(res, 200, view(w)); }
  if (path === '/wallet/entries' && m === 'GET') {
    const lim = single(q, 'limit'); const cur = single(q, 'cursor'); const limit = lim === undefined ? 100 : Number(lim);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new HttpErr(400, 'INVALID_QUERY'); if (cur !== undefined && !/^\d{1,18}$/.test(cur)) throw new HttpErr(400, 'INVALID_QUERY');
    if (!wallet(t, c)) throw new HttpErr(404, 'WALLET_NOT_FOUND'); const all = ENTRY(t, c).filter((e) => cur === undefined || e.entryId > Number(cur)); const page = all.slice(0, limit);
    return send(res, 200, { items: page, nextCursor: all.length > limit ? String(page[page.length - 1].entryId) : null }); }
  if (path === '/topups' && m === 'POST') {
    const key = hv(req, 'idempotency-key'); if (key === undefined || key === '') throw new HttpErr(400, 'MISSING_IDEMPOTENCY_KEY'); if (key.length > 255 || key !== key.trim()) throw new HttpErr(400, 'INVALID_IDEMPOTENCY_KEY');
    const b = parseJson(raw); if (!isObj(b)) throw new HttpErr(400, 'INVALID_REQUEST'); if (typeof b.amount !== 'number') throw new HttpErr(400, 'INVALID_REQUEST');
    const w = wallet(t, c); if (!w) throw new HttpErr(404, 'WALLET_NOT_FOUND'); money(b.amount, w.currency); const hash = JSON.stringify([b.amount, w.currency]);
    const ex = W.topupKeys.get(t + '|' + c + '|' + key); if (ex) { if (ex.hash !== hash) throw new HttpErr(422, 'IDEMPOTENCY_KEY_REUSED'); return send(res, 202, ex.body); }
    if (b.amount < 1 || b.amount > 1e12) throw new HttpErr(400, 'INVALID_REQUEST');
    const id = uid('tp_'); const tp = { id, customerId: c, amount: b.amount, currency: w.currency, status: 'REQUESTED', chargeId: null, failureCode: null, createdAt: now().toISOString(), completedAt: null }; W.topups.set(t + '|' + id, tp);
    const body = { topupId: id, status: 'REQUESTED', amount: b.amount, currency: w.currency, createdAt: tp.createdAt }; W.topupKeys.set(t + '|' + c + '|' + key, { hash, body });
    setTimeout(() => { const r = createCharge({ key: 'wallet-' + id, amount: tp.amount, currency: tp.currency, reference: id, metadata: { tenantId: t }, simulate: undefined }); tp.status = 'PENDING'; tp.chargeId = r.body.chargeId; }, 100);
    return send(res, 202, body); }
  if (seg[0] === 'topups' && seg.length === 2 && m === 'GET') { const tp = W.topups.get(t + '|' + seg[1]); if (!tp || tp.customerId !== c) throw new HttpErr(404, 'TOPUP_NOT_FOUND');
    return send(res, 200, { topupId: tp.id, status: tp.status, amount: tp.amount, currency: tp.currency, ...(tp.failureCode ? { failureCode: tp.failureCode } : {}), createdAt: tp.createdAt, ...(tp.completedAt ? { completedAt: tp.completedAt } : {}) }); }
  throw new HttpErr(404, 'NOT_FOUND');
}
function opsHandler(req, res, raw, seg, m, q) {
  const { t, actor } = opsGuard(req); const parts = seg.slice(1);
  if (m === 'GET' && parts[0] === 'actions') { const lim = single(q, 'limit'); const cur = single(q, 'cursor'); const limit = lim === undefined ? 50 : Number(lim);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new HttpErr(400, 'INVALID_QUERY'); if (cur !== undefined && !/^[1-9]\d{0,17}$/.test(cur)) throw new HttpErr(400, 'INVALID_QUERY');
    let rows = W.ops.filter((o) => o.tenant === t).sort((a, b) => b.seq - a.seq); if (cur !== undefined) rows = rows.filter((o) => o.seq < Number(cur)); const page = rows.slice(0, limit);
    return send(res, 200, { items: page.map((o) => ({ id: o.id, action: o.action, actor: o.actor, reason: o.reason, target: o.target, createdAt: o.createdAt })), nextCursor: page.length === limit && rows.length > limit ? String(page[page.length - 1].seq) : null }); }
  if (m !== 'POST') throw new HttpErr(404, 'NOT_FOUND'); const bodyRaw = parseJson(raw); if (!isObj(bodyRaw)) throw new HttpErr(400, 'INVALID_REQUEST', 'body must be a JSON object');
  if (parts[0] === 'wallets' && (parts[2] === 'freeze' || parts[2] === 'unfreeze')) {
    const c = parts[1]; if (!CUST.test(c)) throw new HttpErr(400, 'INVALID_REQUEST'); const { reason, key } = opsCommon(bodyRaw, actor); const w = wallet(t, c); if (!w) throw new HttpErr(404, 'WALLET_NOT_FOUND'); const want = parts[2] === 'freeze';
    return send(res, 200, opsRun(t, key, JSON.stringify([parts[2], c]), want ? 'FREEZE' : 'UNFREEZE', 'wallet:' + c, actor, reason, (actionId) => {
      if (w.frozen === want) return { noop: true, result: { customerId: c, frozen: want, changed: false, frozenAt: w.frozenAt || null, actionId: null } };
      w.frozen = want; w.frozenAt = want ? now().toISOString() : null; return { result: { customerId: c, frozen: want, changed: true, frozenAt: w.frozenAt } }; })); }
  if (parts[0] === 'wallets' && parts[2] === 'adjustments') {
    const c = parts[1]; if (!CUST.test(c)) throw new HttpErr(400, 'INVALID_REQUEST'); const { reason, key } = opsCommon(bodyRaw, actor); const dir = text(bodyRaw.direction); if (dir !== 'CREDIT' && dir !== 'DEBIT') throw new HttpErr(422, 'INVALID_OPS_REQUEST');
    const amt = typeof bodyRaw.amount === 'number' ? bodyRaw.amount : NaN; if (!Number.isSafeInteger(amt) || amt <= 0) throw new HttpErr(422, 'INVALID_OPS_REQUEST'); const w = wallet(t, c); if (!w) throw new HttpErr(404, 'WALLET_NOT_FOUND'); if (text(bodyRaw.currency) !== w.currency) throw new HttpErr(422, 'INVALID_OPS_REQUEST');
    return send(res, 201, opsRun(t, key, JSON.stringify(['ADJUST', c, dir, amt, w.currency]), 'ADJUST', 'wallet:' + c, actor, reason, (actionId) => {
      const delta = dir === 'CREDIT' ? amt : -amt; if (w.balance + delta < 0) throw new HttpErr(409, 'INSUFFICIENT_FUNDS'); w.balance += delta; const tx = post(t, c, 'ADJUSTMENT', 'adjustment:' + actionId, delta); return { result: { transactionId: tx } }; })); }
  if (parts[0] === 'transactions' && parts[2] === 'reversals') {
    const { reason, key } = opsCommon(bodyRaw, actor); const tx = W.txs.get(t + '|' + parts[1]); if (!tx) throw new HttpErr(404, 'TRANSACTION_NOT_FOUND');
    return send(res, 201, opsRun(t, key, JSON.stringify(['REVERSE', parts[1]]), 'REVERSE', 'transaction:' + parts[1], actor, reason, (actionId) => {
      if (tx.kind === 'TOPUP' || tx.kind === 'REVERSAL') throw new HttpErr(409, 'REVERSAL_NOT_SUPPORTED'); if (tx.reversed) throw new HttpErr(409, 'ALREADY_REVERSED');
      const w = wallet(t, tx.customer); const delta = -tx.amount; if (w.balance + delta < 0) throw new HttpErr(409, 'INSUFFICIENT_FUNDS'); w.balance += delta; tx.reversed = true; const rt = post(t, tx.customer, 'REVERSAL', 'reversal:' + tx.id, delta); return { result: { transactionId: rt, reversesTransactionId: tx.id } }; })); }
  if (parts[0] === 'orders' && parts[2] === 'replay-paid') { opsCommon(bodyRaw, actor); throw new HttpErr(404, 'ORDER_NOT_FOUND'); }
  throw new HttpErr(404, 'NOT_FOUND');
}
const DATE = /^\d{4}-\d{2}-\d{2}$/;
function checkDay(d) { if (!DATE.test(d)) throw new HttpErr(422, 'INVALID_RECONCILIATION', 'format'); const f = new Date(d + 'T00:00:00.000Z'); if (Number.isNaN(f.getTime()) || f.toISOString().slice(0, 10) !== d) throw new HttpErr(422, 'INVALID_RECONCILIATION', 'cal'); if (f.getTime() > Date.UTC(now().getUTCFullYear(), now().getUTCMonth(), now().getUTCDate())) throw new HttpErr(422, 'INVALID_RECONCILIATION', 'future'); }
function reconHandler(req, res, raw, seg, m, q) {
  const t = tenantOf(hv(req, 'x-tenant-id'));
  if (seg[0] === 'reconciliations' && seg.length === 1 && m === 'POST') { const b = parseJson(raw); if (!isObj(b)) throw new HttpErr(400, 'INVALID_REQUEST'); const day = text(b.date); checkDay(day);
    const id = uid('run_'); const run = { id, tenant: t, day, status: 'RUNNING', triggeredBy: 'MANUAL', failureReason: null, gatewayTotals: {}, walletTotals: {}, itemCount: 0, startedAt: now().toISOString(), finishedAt: null }; W.runs.set(t + '|' + id, run);
    setTimeout(() => { const items = []; for (const c of P.charges.values()) { if (c.status === 'PENDING' || !c.completedAt || c.completedAt.slice(0, 10) !== day) continue; if (!c.metadata.tenantId || c.metadata.tenantId !== t) continue; if (!W.topups.get(t + '|' + c.reference)) items.push(c); }
      for (const c of items) W.items.set(t + '|' + (++W.itemSeq), { seq: W.itemSeq, id: 'it_' + W.itemSeq, runId: id, kind: 'UNKNOWN_CHARGE', chargeId: c.chargeId, topupId: null, amountGateway: c.amount, amountWallet: null, currency: c.currency, detail: {}, action: 'NONE', caseStatus: 'OPEN', resolvedBy: null, resolutionNote: null, resolvedAt: null, createdAt: now().toISOString() });
      run.status = 'COMPLETED'; run.itemCount = items.length; run.finishedAt = now().toISOString(); }, 300);
    return send(res, 202, { runId: id, status: 'RUNNING' }); }
  if (seg[0] === 'reconciliations' && seg.length === 2 && m === 'GET') { const r = W.runs.get(t + '|' + seg[1]); if (!r) throw new HttpErr(404, 'RECONCILIATION_NOT_FOUND'); const { tenant, ...v } = r; return send(res, 200, v); }
  if (seg[0] === 'reconciliations' && seg[2] === 'items' && m === 'GET') {
    const cs = single(q, 'caseStatus'); const lim = single(q, 'limit'); const cur = single(q, 'cursor'); const limit = lim === undefined ? 100 : Number(lim);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new HttpErr(400, 'INVALID_QUERY'); if (cur !== undefined && !/^\d{1,15}$/.test(cur)) throw new HttpErr(400, 'INVALID_QUERY'); if (cs !== undefined && !['OPEN', 'RESOLVED', 'IGNORED'].includes(cs)) throw new HttpErr(400, 'INVALID_QUERY');
    if (!W.runs.get(t + '|' + seg[1])) throw new HttpErr(404, 'RECONCILIATION_NOT_FOUND'); let rows = [...W.items.entries()].filter(([k, i]) => k.startsWith(t + '|') && i.runId === seg[1] && (cs === undefined || i.caseStatus === cs)).map(([, i]) => i).sort((a, b) => a.seq - b.seq);
    if (cur !== undefined) rows = rows.filter((i) => i.seq > Number(cur)); const page = rows.slice(0, limit); return send(res, 200, { items: page.map(({ seq, ...i }) => i), nextCursor: rows.length > limit ? String(page[page.length - 1].seq) : null }); }
  if (seg[0] === 'reconciliation-items' && seg[2] === 'resolve' && m === 'POST') { const b = parseJson(raw); if (!isObj(b)) throw new HttpErr(400, 'INVALID_REQUEST');
    const status = text(b.status), note = text(b.note), by = text(b.resolvedBy); if (status !== 'RESOLVED' && status !== 'IGNORED') throw new HttpErr(422, 'INVALID_RECONCILIATION'); if (note.length < 1 || note.length > 500) throw new HttpErr(422, 'INVALID_RECONCILIATION'); if (by.length < 1 || by.length > 64) throw new HttpErr(422, 'INVALID_RECONCILIATION');
    const it = [...W.items.entries()].find(([k, i]) => k.startsWith(t + '|') && i.id === seg[1]); if (!it) throw new HttpErr(404, 'RECONCILIATION_ITEM_NOT_FOUND'); const i = it[1];
    if (i.caseStatus === 'OPEN') { i.caseStatus = status; i.resolvedBy = by; i.resolutionNote = note; i.resolvedAt = now().toISOString(); } else if (!(i.caseStatus === status && i.resolvedBy === by && i.resolutionNote === note)) throw new HttpErr(409, 'RECONCILIATION_CONFLICT');
    const { seq, ...v } = i; return send(res, 200, v); }
  throw new HttpErr(404, 'NOT_FOUND');
}
// ---------- payment handler ----------
async function paymentHandler(req, res, raw) {
  const { path, q } = query(req.url); const m = req.method;
  if (m === 'GET' && path === '/health') return send(res, 200, { status: 'ok', service: 'payment' });
  if (m === 'POST' && path === '/charges') {
    const key = hv(req, 'idempotency-key'); if (key === undefined || key.trim() === '') throw new HttpErr(400, 'MISSING_IDEMPOTENCY_KEY'); if (key !== key.trim() || key.length > 255) throw new HttpErr(400, 'INVALID_IDEMPOTENCY_KEY');
    const b = parseJson(raw); if (!isObj(b)) throw new HttpErr(400, 'INVALID_REQUEST'); if (typeof b.amount !== 'number' || typeof b.currency !== 'string' || typeof b.reference !== 'string') throw new HttpErr(400, 'INVALID_REQUEST');
    const r = createCharge({ key, amount: b.amount, currency: b.currency, reference: b.reference, metadata: b.metadata, simulate: hv(req, 'x-simulate') });
    if (r.sc.timeout && !r.replayed) await new Promise((x) => setTimeout(x, RESP_TIMEOUT)); return send(res, r.status, r.body); }
  if (m === 'GET' && path.startsWith('/charges/')) { const c = P.charges.get(path.slice(9)); if (!c) throw new HttpErr(404, 'CHARGE_NOT_FOUND'); return send(res, 200, chargeView(c)); }
  if (m === 'GET' && path === '/settlements') {
    const date = single(q, 'date') || ''; const lim = single(q, 'limit'); const cur = single(q, 'cursor');
    if (!DATE.test(date)) throw new HttpErr(400, 'INVALID_QUERY'); const f = new Date(date + 'T00:00:00.000Z'); if (Number.isNaN(f.getTime()) || f.toISOString().slice(0, 10) !== date) throw new HttpErr(400, 'INVALID_QUERY'); if (f.getTime() > Date.UTC(now().getUTCFullYear(), now().getUTCMonth(), now().getUTCDate())) throw new HttpErr(400, 'INVALID_QUERY');
    const limit = lim === undefined ? 500 : Number(lim); if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new HttpErr(400, 'INVALID_QUERY');
    let after = null; if (cur !== undefined) { try { const j = JSON.parse(Buffer.from(cur, 'base64url').toString('utf8')); if (typeof j.c !== 'string' || typeof j.i !== 'string' || j.i === '' || new Date(j.c).toISOString() !== j.c) throw 0; after = j; } catch { throw new HttpErr(400, 'INVALID_QUERY'); } }
    let rows = [...P.charges.values()].filter((c) => c.completedAt && c.completedAt.slice(0, 10) === date).sort((a, b) => (a.completedAt < b.completedAt ? -1 : a.completedAt > b.completedAt ? 1 : a.chargeId < b.chargeId ? -1 : 1));
    const totals = []; for (const c of rows) { let t = totals.find((x) => x.currency === c.currency && x.status === c.status); if (!t) totals.push((t = { currency: c.currency, status: c.status, count: 0, amount: 0 })); t.count++; t.amount += c.amount; }
    if (after) rows = rows.filter((c) => c.completedAt > after.c || (c.completedAt === after.c && c.chargeId > after.i)); const page = rows.slice(0, limit); const last = page[page.length - 1];
    return send(res, 200, { date, items: page.map((c) => ({ chargeId: c.chargeId, reference: c.reference, amount: c.amount, currency: c.currency, status: c.status, ...(c.failureCode ? { failureCode: c.failureCode } : {}), ...(Object.keys(c.metadata).length ? { metadata: c.metadata } : {}), completedAt: c.completedAt })), nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ c: last.completedAt, i: last.chargeId })).toString('base64url') : null, totals }); }
  throw new HttpErr(404, 'NOT_FOUND');
}
const FLAKY = parseFloat(process.env.MOCK_FLAKY || '0');
const flakyHit = (req) => FLAKY > 0 && req.method === 'POST' && /^\/(topups|ops\/)/.test(req.url) && Math.random() < FLAKY;
const wrap = (fn) => async (req, res) => { try { const raw = await readBody(req);
    if (flakyHit(req)) { if (Math.random() < 0.5) return send(res, 503, { error: { code: 'UNAVAILABLE', message: 'injected before processing' } });
      try { await fn(req, { writeHead() {}, end() {} }, raw); } catch { /* đã xử lý (hoặc bị từ chối) nhưng client không thấy phản hồi */ } return send(res, 503, { error: { code: 'UNAVAILABLE', message: 'injected: response lost' } }); }
    await fn(req, res, raw); } catch (e) { if (e instanceof HttpErr) send(res, e.status, { error: { code: e.code, message: e.message } }); else { console.error(e); send(res, 500, { error: { code: 'INTERNAL', message: 'internal error' } }); } } };
http.createServer(wrap(walletHandler)).listen(3001, '127.0.0.1', () => console.log('mock wallet :3001'));
http.createServer(wrap(paymentHandler)).listen(3002, '127.0.0.1', () => console.log('mock payment :3002'));
