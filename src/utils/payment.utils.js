export const paymentError = (message, status) => Object.assign(new Error(message), { status });
const max = 999999999999n;
export const moneyCents = value => {
  const text = value?.toString();
  if (!text || !/^\d{1,10}(\.\d{1,2})?$/.test(text)) throw paymentError('Invalid payment amount', 400);
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
};
export const fixedMoney = value => {
  const sign = value < 0n ? '-' : '';
  const absolute = value < 0n ? -value : value;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
};
export const paymentAmounts = total => {
  const cents = moneyCents(total);
  const payable = ((cents + 50n) / 100n) * 100n;
  if (payable > max) throw paymentError('Rounded payment amount exceeds supported limit', 400);
  return { orderTotalAmount: fixedMoney(cents), amount: fixedMoney(payable), roundingAdjustment: fixedMoney(payable - cents), grossAmount: Number(payable / 100n) };
};
export const validateQrisAmount = amounts => {
  if (amounts.grossAmount < 1 || amounts.grossAmount > 10000000) throw paymentError('QRIS amount must be IDR 1–10000000', 400);
};
export const validatePayment = body => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Invalid payment fields' };
  const fields = body.method === 'CASH' ? ['requestId', 'method', 'cashReceived'] : ['requestId', 'method'];
  if (!['CASH', 'QRIS'].includes(body.method) || Object.keys(body).length !== fields.length || Object.keys(body).some(key => !fields.includes(key))) return { error: 'Invalid payment fields' };
  if (typeof body.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(body.requestId)) return { error: 'requestId must be a canonical lowercase UUID' };
  const data = { requestId: body.requestId, method: body.method };
  if (body.method === 'CASH') {
    if (!['number', 'string'].includes(typeof body.cashReceived)) return { error: 'Invalid cashReceived' };
    try { data.cashReceived = fixedMoney(moneyCents(body.cashReceived)); }
    catch { return { error: 'cashReceived must be 0–9999999999.99 with at most two decimals' }; }
  }
  return { data };
};
export const samePaymentRequest = (payment, data) => payment.method === data.method && (data.method !== 'CASH' || moneyCents(payment.cashReceived) === moneyCents(data.cashReceived));
export const legacyPaymentHold = async (tx, orderId) => {
  const legacy = await tx.payment.count({ where: { orderId, OR: [{ requestId: null }, { orderTotalAmount: null }, { roundingAdjustment: null }, { method: 'CASH', status: 'PENDING' }] } });
  return legacy ? 'LEGACY_PAYMENT_REQUIRES_RECONCILIATION' : null;
};
const moneyFields = ['amount', 'orderTotalAmount', 'roundingAdjustment', 'cashReceived', 'changeAmount'];
export const serializePayment = payment => {
  const result = {};
  for (const key of ['id', 'orderId', 'requestId', 'attemptNumber', 'method', 'status', ...moneyFields, 'midtransOrderId', 'midtransTransactionId', 'midtransStatus', 'qrisQrUrl', 'qrisPayload', 'expiresAt', 'paidAt', 'createdAt', 'updatedAt', 'dispatchClaimedAt', 'dispatchFinishedAt', 'reconciliationReason']) {
    const value = payment[key];
    if (value === undefined) continue;
    if (moneyFields.includes(key) && value !== null) {
      const text = value.toString();
      result[key] = fixedMoney(text.startsWith('-') ? -moneyCents(text.slice(1)) : moneyCents(text));
    } else result[key] = value;
  }
  return result;
};
export const handlePaymentError = (res, error) => {
  if ([400, 403, 404, 409, 502, 503].includes(error.status)) return res.status(error.status).json({ message: error.message });
  const cause = error.meta?.driverAdapterError?.cause;
  if (error.code === 'P2034' || (error.code === 'P2010' && [1205, 1213, '1205', '1213'].includes(cause?.originalCode ?? cause?.code))) return res.status(503).json({ message: 'Payment is busy; reconcile before retrying' });
  if (error.code === 'P2002') return res.status(409).json({ message: 'Payment request conflict; reconcile before retrying' });
  return res.status(500).json({ message: 'Server error' });
};
