import { fixedMoney, moneyCents } from './payment.utils.js';

export const notificationError = (status, message = 'Notifications unavailable; retry later') => Object.assign(new Error(message), { status });
export const boundedNotificationJson = (data, max = 16384) => {
  if (Buffer.byteLength(JSON.stringify(data)) > max) throw notificationError(503);
  return data;
};
export const parseNotificationQuery = (originalUrl, kind) => {
  const invalid = () => notificationError(400, 'Invalid notification request');
  const query = originalUrl.includes('?') ? originalUrl.slice(originalUrl.indexOf('?') + 1) : '';
  try { for (const part of query.split('&')) for (const value of part.split('=')) decodeURIComponent(value.replaceAll('+', ' ')); }
  catch { throw invalid(); }
  const values = {};
  for (const [key, value] of new URLSearchParams(query)) {
    if (kind !== 'list' || !['page', 'limit', 'unread'].includes(key) || Object.hasOwn(values, key)) throw invalid();
    values[key] = value;
  }
  const positive = (value, max) => {
    if (!/^[1-9]\d{0,9}$/.test(value) || Number(value) > max) throw invalid();
    return Number(value);
  };
  const page = values.page === undefined ? 1 : positive(values.page, 2147483647), limit = values.limit === undefined ? 20 : positive(values.limit, 100);
  if ((page - 1) * limit > 2147483647 || values.unread !== undefined && !['true', 'false'].includes(values.unread)) throw invalid();
  return { page, limit, ...(values.unread === undefined ? {} : { unread: values.unread === 'true' }) };
};
export const paymentNotificationData = (order, payment) => boundedNotificationJson({ orderId: String(order.id), paymentId: String(payment.id), orderNumber: order.orderNumber, amount: fixedMoney(moneyCents(payment.amount)), method: payment.method, paidAt: payment.paidAt.toISOString() });
const concurrencyError = (error, depth = 0) => {
  if (!error || typeof error !== 'object' || depth > 6) return false;
  return ['code', 'errno', 'originalCode'].some(key => ['1205', '1213', 'P2034'].includes(String(error[key]))) || ['cause', 'meta', 'driverAdapterError'].some(key => concurrencyError(error[key], depth + 1));
};
export const retryNotificationTransaction = async operation => {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (!concurrencyError(error)) throw error;
      if (attempt === 2) throw notificationError(503);
    }
  }
};
export const createPaymentSuccessNotification = async (tx, order, payment) => {
  try { return await tx.notification.create({ data: { recipientUserId: order.cashierId, type: 'PAYMENT_SUCCESS', eventKey: `payment:${payment.id}:success`, data: paymentNotificationData(order, payment) } }); }
  catch (error) { if (concurrencyError(error)) throw error; throw notificationError(503); }
};
