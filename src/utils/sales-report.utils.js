import { setImmediate } from 'node:timers/promises';
import { calculateOrder } from './order.utils.js';
import { moneyCents, fixedMoney, paymentAmounts } from './payment.utils.js';

export const SALES_LIMITS = Object.freeze({ candidates: 10000, related: 100000, inputBytes: 16 * 1024 * 1024, outputBytes: 32 * 1024 * 1024 });
export const salesError = (status, message) => Object.assign(new Error(message), { status });
const signedCents = value => String(value).startsWith('-') ? -moneyCents(String(value).slice(1)) : moneyCents(value);
const amountKeys = ['collectedAmount', 'originalTotalAmount', 'roundingAdjustment', 'taxAmount', 'netSalesAmount'];
const bucket = () => ({ paidOrderCount: 0, unitsSold: 0, ...Object.fromEntries(amountKeys.map(key => [key, 0n])) });
const serializeBucket = value => ({ ...value, ...Object.fromEntries(amountKeys.map(key => [key, fixedMoney(value[key])])) });
const addBucket = (target, values, units) => {
  target.paidOrderCount++; target.unitsSold += units;
  for (const key of amountKeys) target[key] += values[key];
};
const groupRows = async (rows, key, signal) => {
  const map = new Map();
  for (let i = 0; i < rows.length; i++) {
    if (i % 128 === 0) { await setImmediate(); signal?.throwIfAborted(); }
    const row = rows[i], id = row[key];
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(row);
  }
  return map;
};
const historyFlags = async (attempts, signal) => {
  const map = new Map();
  for (let i = 0; i < attempts.length; i++) {
    if (i % 128 === 0) { await setImmediate(); signal?.throwIfAborted(); }
    const row = attempts[i];
    if (!map.has(row.orderId)) map.set(row.orderId, { paid: 0, pending: false, reconciliation: false, legacy: false });
    const flags = map.get(row.orderId);
    if (row.status === 'PAID') flags.paid++;
    flags.pending ||= row.status === 'PENDING';
    flags.reconciliation ||= Boolean(row.reconciliationReason);
    flags.legacy ||= !row.requestId || row.orderTotalAmount == null || row.roundingAdjustment == null || (row.method === 'CASH' && row.status === 'PENDING');
  }
  return map;
};
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const businessDate = date => new Date(date.getTime() + 7 * 3600000).toISOString().slice(0, 10);
const reasonOrder = ['ORDER_NOT_COMPLETED', 'ORDER_HELD', 'MULTIPLE_PAID_ATTEMPTS', 'COMPETING_PENDING_ATTEMPT', 'ATTEMPT_REQUIRES_RECONCILIATION', 'LEGACY_PAYMENT_HISTORY', 'INVALID_FINANCIAL_SNAPSHOT'];
const validateFinancials = (order, payment, items) => {
  if (!items.length || items.length > 100) throw Error('Invalid items');
  const calculated = calculateOrder(items, { ...order, taxName: 'Captured tax' });
  for (const key of ['subtotalAmount', 'taxAmount', 'totalAmount']) if (moneyCents(order[key]) !== moneyCents(calculated[key])) throw Error('Invalid total');
  items.forEach((item, i) => { if (moneyCents(item.subtotal) !== moneyCents(calculated.items[i].subtotal)) throw Error('Invalid line'); });
  const expected = paymentAmounts(order.totalAmount);
  if (!['CASH', 'QRIS'].includes(payment.method) || moneyCents(payment.orderTotalAmount) !== moneyCents(order.totalAmount) || moneyCents(payment.amount) !== moneyCents(expected.amount) || signedCents(payment.roundingAdjustment) !== signedCents(expected.roundingAdjustment)) throw Error('Invalid payment');
  if (payment.method === 'CASH' && moneyCents(payment.cashReceived) - moneyCents(payment.amount) !== moneyCents(payment.changeAmount)) throw Error('Invalid tender');
  const tax = moneyCents(order.taxAmount), original = moneyCents(order.totalAmount);
  if (tax > original) throw Error('Invalid tax');
  return { collectedAmount: moneyCents(payment.amount), originalTotalAmount: original, roundingAdjustment: signedCents(payment.roundingAdjustment), taxAmount: tax, netSalesAmount: original - tax };
};
export const projectSales = async ({ payments, orders, items, attempts, undatedPaidCount }, filters, generatedAt, { signal } = {}) => {
  signal?.throwIfAborted();
  const orderMap = new Map(orders.map(row => [row.id, row])), itemMap = await groupRows(items, 'orderId', signal), attemptMap = await historyFlags(attempts, signal);
  let index = 0;
  const summary = bucket(), daily = new Map(), methods = new Map(['CASH', 'QRIS'].map(method => [method, bucket()])), cashiers = new Map(), products = new Map(), transactions = [], reasonCounts = new Map();
  for (let time = calendar(filters.from); time <= calendar(filters.to); time += dayMs) daily.set(new Date(time).toISOString().slice(0, 10), bucket());
  for (const payment of [...payments].sort((a, b) => a.paidAt - b.paidAt || a.id - b.id)) {
    if (index++ % 128 === 0) { await setImmediate(); signal?.throwIfAborted(); }
    const order = orderMap.get(payment.orderId), lines = itemMap.get(payment.orderId) || [], history = attemptMap.get(payment.orderId);
    const reasons = new Set();
    if (!order || order.status !== 'COMPLETED') reasons.add('ORDER_NOT_COMPLETED');
    if (order?.paymentHoldReason) reasons.add('ORDER_HELD');
    if (history?.paid !== 1) reasons.add('MULTIPLE_PAID_ATTEMPTS');
    if (history?.pending) reasons.add('COMPETING_PENDING_ATTEMPT');
    if (history?.reconciliation) reasons.add('ATTEMPT_REQUIRES_RECONCILIATION');
    if (history?.legacy) reasons.add('LEGACY_PAYMENT_HISTORY');
    let values;
    try { values = validateFinancials(order, payment, lines); } catch { reasons.add('INVALID_FINANCIAL_SNAPSHOT'); }
    const reviewReasons = reasonOrder.filter(reason => reasons.has(reason)), date = businessDate(payment.paidAt), cashierName = order?.receiptCashierName || 'Unavailable';
    const raw = value => value == null ? null : String(value);
    const clean = !reviewReasons.length;
    transactions.push({ paymentId: String(payment.id), orderId: String(payment.orderId), orderNumber: order?.orderNumber || 'Unavailable', paidAt: payment.paidAt.toISOString(), businessDate: date, cashierId: order ? String(order.cashierId) : null, cashierName, method: payment.method, classification: clean ? 'clean' : 'review', reviewReasons, originalTotalAmount: clean ? fixedMoney(values.originalTotalAmount) : raw(payment.orderTotalAmount), roundingAdjustment: clean ? fixedMoney(values.roundingAdjustment) : raw(payment.roundingAdjustment), collectedAmount: clean ? fixedMoney(values.collectedAmount) : raw(payment.amount), taxAmount: clean ? fixedMoney(values.taxAmount) : raw(order?.taxAmount), netSalesAmount: clean ? fixedMoney(values.netSalesAmount) : null });
    if (!clean) { for (const reason of reviewReasons) reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1); continue; }
    const units = lines.reduce((sum, item) => sum + item.quantity, 0);
    addBucket(summary, values, units); addBucket(daily.get(date), values, units); addBucket(methods.get(payment.method), values, units);
    const cashierKey = JSON.stringify([order.cashierId, cashierName]);
    if (!cashiers.has(cashierKey)) cashiers.set(cashierKey, { cashierId: String(order.cashierId), cashierName, ...bucket() });
    addBucket(cashiers.get(cashierKey), values, units);
    const seenProducts = new Set();
    for (const item of lines) {
      const price = fixedMoney(moneyCents(item.unitPrice)), key = JSON.stringify([item.productId ?? null, item.productName, price]);
      if (!products.has(key)) products.set(key, { productId: item.productId == null ? null : String(item.productId), productName: item.productName || 'Unavailable', unitPrice: price, unitsSold: 0, paidOrderCount: 0, merchandiseAmount: 0n });
      const product = products.get(key); product.unitsSold += item.quantity; product.merchandiseAmount += moneyCents(item.subtotal);
      if (!seenProducts.has(key)) { product.paidOrderCount++; seenProducts.add(key); }
    }
  }
  const publicFilters = { from: filters.from, to: filters.to, timezone: filters.timezone, cashierId: filters.cashierId == null ? null : String(filters.cashierId), method: filters.method };
  return { filters: publicFilters, generatedAt: generatedAt.toISOString(), summary: serializeBucket(summary), daily: [...daily].map(([date, value]) => ({ date, ...serializeBucket(value) })), methods: [...methods].map(([method, value]) => ({ method, ...serializeBucket(value) })), cashiers: [...cashiers.values()].sort((a, b) => compareText(b.collectedAmount, a.collectedAmount) || Number(a.cashierId) - Number(b.cashierId) || compareText(a.cashierName, b.cashierName)).map(serializeBucket), products: [...products.values()].sort((a, b) => b.unitsSold - a.unitsSold || compareText(b.merchandiseAmount, a.merchandiseAmount) || compareText(JSON.stringify([a.productId, a.productName, a.unitPrice]), JSON.stringify([b.productId, b.productName, b.unitPrice]))).map(row => ({ ...row, merchandiseAmount: fixedMoney(row.merchandiseAmount) })), review: { candidateCount: payments.length, cleanCount: summary.paidOrderCount, reviewCount: payments.length - summary.paidOrderCount, undatedPaidCount, reasons: reasonOrder.filter(reason => reasonCounts.has(reason)).map(reason => ({ reason, count: reasonCounts.get(reason) })) }, transactions };
};
const paymentSelect = Object.fromEntries(['id', 'orderId', 'method', 'status', 'requestId', 'orderTotalAmount', 'roundingAdjustment', 'amount', 'cashReceived', 'changeAmount', 'paidAt', 'reconciliationReason'].map(key => [key, true]));
const orderSelect = Object.fromEntries(['id', 'orderNumber', 'cashierId', 'receiptCashierName', 'status', 'paymentHoldReason', 'subtotalAmount', 'taxAmount', 'totalAmount', 'taxRate', 'taxName', 'taxInclusive'].map(key => [key, true]));
const itemSelect = Object.fromEntries(['orderId', 'productId', 'productName', 'unitPrice', 'quantity', 'subtotal'].map(key => [key, true]));
const tooLarge = () => salesError(422, 'Sales report exceeds limits; narrow filters');
export const loadSalesReport = async (db, filters, { signal, generatedAt = new Date() } = {}) => {
  signal?.throwIfAborted();
  return db.$transaction(async tx => {
    const common = { status: 'PAID', ...(filters.method ? { method: filters.method } : {}), ...(filters.cashierId ? { order: { cashierId: filters.cashierId } } : {}) };
    const where = { ...common, paidAt: { gte: filters.start, lt: filters.end } };
    const count = await tx.payment.count({ where });
    if (count > SALES_LIMITS.candidates) throw tooLarge();
    signal?.throwIfAborted();
    const undatedPaidCount = await tx.payment.count({ where: { ...common, paidAt: null } });
    const ids = await tx.payment.findMany({ where, select: { id: true, orderId: true }, orderBy: [{ paidAt: 'asc' }, { id: 'asc' }] });
    const orderIds = [...new Set(ids.map(row => row.orderId))];
    if (!ids.length) return projectSales({ payments: [], orders: [], items: [], attempts: [], undatedPaidCount }, filters, generatedAt, { signal });
    const related = { orderId: { in: orderIds } };
    const itemCount = await tx.orderItem.count({ where: related }), attemptCount = await tx.payment.count({ where: related });
    if (itemCount > SALES_LIMITS.related || attemptCount > SALES_LIMITS.related) throw tooLarge();
    signal?.throwIfAborted();
    // Only selected bounded labels enter memory; no addresses or provider JSON.
    const placeholders = orderIds.map(() => '?').join(',');
    const [size] = await tx.$queryRawUnsafe(`SELECT
      (SELECT COALESCE(SUM(OCTET_LENGTH(order_number)+COALESCE(OCTET_LENGTH(receipt_cashier_name),0)+COALESCE(OCTET_LENGTH(tax_name),0)+COALESCE(OCTET_LENGTH(payment_hold_reason),0)),0) FROM orders WHERE id IN (${placeholders})) +
      (SELECT COALESCE(SUM(OCTET_LENGTH(product_name)),0) FROM order_items WHERE order_id IN (${placeholders})) +
      (SELECT COALESCE(SUM(COALESCE(OCTET_LENGTH(request_id),0)+COALESCE(OCTET_LENGTH(reconciliation_reason),0)),0) FROM payments WHERE order_id IN (${placeholders})) AS bytes`, ...orderIds, ...orderIds, ...orderIds);
    if (BigInt(size.bytes) > BigInt(SALES_LIMITS.inputBytes)) throw tooLarge();
    const orders = await tx.order.findMany({ where: { id: { in: orderIds } }, select: orderSelect });
    const items = await tx.orderItem.findMany({ where: related, select: itemSelect, orderBy: { id: 'asc' } });
    const attempts = await tx.payment.findMany({ where: related, select: paymentSelect });
    const selected = new Set(ids.map(row => row.id)), payments = attempts.filter(row => selected.has(row.id));
    let bytes = 0;
    for (const row of [...orders, ...items, ...attempts]) for (const value of Object.values(row)) if (typeof value === 'string') bytes += Buffer.byteLength(value);
    if (bytes > SALES_LIMITS.inputBytes) throw tooLarge();
    signal?.throwIfAborted();
    return projectSales({ payments, orders, items, attempts, undatedPaidCount }, filters, generatedAt, { signal });
  }, { isolationLevel: 'RepeatableRead', timeout: 30000 });
};
const invalid = () => salesError(400, 'Invalid sales report query');
const dayMs = 86400000;
const calendar = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '') || value < '1000-01-01' || value > '9998-12-31') throw invalid();
  const time = Date.parse(value + 'T00:00:00.000Z');
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) throw invalid();
  return time;
};
export const parseSalesQuery = (originalUrl, kind) => {
  const raw = originalUrl.slice(originalUrl.indexOf('?') + 1);
  const query = originalUrl.includes('?') ? raw : '';
  try {
    for (const part of query.split('&')) for (const component of part.split('=')) decodeURIComponent(component.replaceAll('+', ' '));
  } catch { throw invalid(); }
  const allowed = ['from', 'to', 'cashierId', 'method', ...(kind === 'transactions' ? ['page', 'limit', 'scope'] : kind === 'export' ? ['format', 'scope'] : [])];
  const values = {};
  for (const [key, value] of new URLSearchParams(query)) {
    if (!allowed.includes(key) || Object.hasOwn(values, key)) throw invalid();
    values[key] = value;
  }
  const start = calendar(values.from), last = calendar(values.to);
  if (last < start || (last - start) / dayMs >= 366) throw invalid();
  const positive = (value, max = 2147483647) => {
    if (!/^[1-9]\d{0,9}$/.test(value) || Number(value) > max) throw invalid();
    return Number(value);
  };
  if (values.method !== undefined && !['CASH', 'QRIS'].includes(values.method)) throw invalid();
  if (values.scope !== undefined && !['all', 'clean', 'review'].includes(values.scope)) throw invalid();
  if (kind === 'export' && !['csv', 'xlsx'].includes(values.format)) throw invalid();
  const page = values.page === undefined ? 1 : positive(values.page), limit = values.limit === undefined ? 20 : positive(values.limit, 100);
  if ((page - 1) * limit > 2147483647) throw invalid();
  return { from: values.from, to: values.to, timezone: 'Asia/Jakarta', cashierId: values.cashierId === undefined ? null : positive(values.cashierId), method: values.method || null, start: new Date(start - 7 * 3600000), end: new Date(last + dayMs - 7 * 3600000), page, limit, scope: values.scope || 'all', format: values.format };
};
