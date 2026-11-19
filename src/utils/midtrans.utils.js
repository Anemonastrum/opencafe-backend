import 'dotenv/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { paymentError, moneyCents } from './payment.utils.js';

const validSecret = value => typeof value === 'string' && /^[\x21-\x7e]{1,512}$/.test(value);
export const midtransConfig = (env = process.env) => {
  const environment = env.MIDTRANS_ENV || 'sandbox';
  if (!['sandbox', 'production'].includes(environment) || !validSecret(env.MIDTRANS_SERVER_KEY) || !validSecret(env.MIDTRANS_SIGNATURE_SECRET_KEY)) throw paymentError('Midtrans configuration unavailable', 503);
  return { baseUrl: environment === 'sandbox' ? 'https://api.sandbox.midtrans.com/v2' : 'https://api.midtrans.com/v2', serverKey: env.MIDTRANS_SERVER_KEY, signatureSecretKey: env.MIDTRANS_SIGNATURE_SECRET_KEY };
};
export const validNotification = body => body && typeof body === 'object' && !Array.isArray(body) && typeof body.order_id === 'string' && /^[A-Za-z0-9_.~-]{1,50}$/.test(body.order_id) && typeof body.status_code === 'string' && /^\d{3}$/.test(body.status_code) && typeof body.gross_amount === 'string' && /^\d{1,10}(\.\d{1,2})?$/.test(body.gross_amount) && typeof body.signature_key === 'string' && /^[a-fA-F0-9]{128}$/.test(body.signature_key);
export const verifyMidtransNotification = (body, secret) => {
  if (!validNotification(body) || !validSecret(secret)) return false;
  const expected = createHash('sha512').update(body.order_id + body.status_code + body.gross_amount + secret).digest();
  return timingSafeEqual(expected, Buffer.from(body.signature_key, 'hex'));
};
export const midtransRequest = async (path, { method = 'GET', body, fetchImpl = globalThis.fetch, config = midtransConfig(), timeoutMs = 10000, maxBytes = 65536 } = {}) => {
  const controller = new AbortController();
  let reader, response, timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(paymentError('Midtrans request unavailable; reconcile payment', 502)); }, timeoutMs); });
  const run = async () => {
    response = await fetchImpl(config.baseUrl + path, { method, redirect: 'error', signal: controller.signal, headers: { Authorization: `Basic ${Buffer.from(config.serverKey + ':').toString('base64')}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (response.status === 404) throw paymentError('Midtrans transaction not found; payment remains unresolved', 502);
    if (!response.ok || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '') || Number(response.headers.get('content-length')) > maxBytes || !response.body) throw Error('Invalid response');
    reader = response.body.getReader();
    const chunks = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw Error('Oversized response');
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks);
    if (!isUtf8(bytes)) throw Error('Invalid UTF-8');
    const result = JSON.parse(bytes.toString('utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw Error('Invalid JSON');
    return result;
  };
  try { return await Promise.race([run(), deadline]); }
  catch (error) { controller.abort(); throw paymentError(error.status === 502 ? error.message : 'Midtrans request unavailable; reconcile payment', 502); }
  finally {
    clearTimeout(timer);
    // ponytail: cleanup is best-effort; never wait for a stalled provider stream.
    try { Promise.resolve(reader ? reader.cancel() : response?.body?.cancel()).catch(() => {}); } catch {}
  }
};
export const chargeQris = payment => midtransRequest('/charge', { method: 'POST', body: { payment_type: 'qris', transaction_details: { order_id: payment.midtransOrderId, gross_amount: Number(moneyCents(payment.amount) / 100n) }, qris: { acquirer: 'gopay' } } });
export const getQrisStatus = payment => midtransRequest(`/${encodeURIComponent(payment.midtransOrderId)}/status`);
export const providerObservation = raw => {
  const result = {};
  for (const [key, max] of Object.entries({ order_id: 100, transaction_id: 100, transaction_status: 30, gross_amount: 32, currency: 10, payment_type: 30, fraud_status: 30 })) {
    if (raw[key] !== undefined && (typeof raw[key] !== 'string' || !raw[key].isWellFormed() || /[\x00-\x1f\x7f]/.test(raw[key]) || raw[key].length > max)) throw paymentError('Invalid Midtrans status response', 502);
    if (raw[key] !== undefined) result[key] = raw[key];
  }
  if (!result.order_id || !result.transaction_id || !result.transaction_status || !result.gross_amount) throw paymentError('Incomplete Midtrans status response', 502);
  result.observedAt = new Date().toISOString();
  return result;
};
export const qrisDetails = raw => {
  const host = new URL(midtransConfig().baseUrl).hostname;
  const action = raw.actions?.find(a => a.name === 'generate-qr-code' && a.method === 'GET');
  const details = {};
  if (action?.url) {
    try { const url = new URL(action.url); if (url.protocol === 'https:' && url.hostname === host && !url.username && !url.password && !url.port && !url.hash) details.qrisQrUrl = url.href; } catch {}
  }
  if (typeof raw.qr_string === 'string' && raw.qr_string.length <= 8192 && raw.qr_string.isWellFormed()) details.qrisPayload = raw.qr_string;
  if (typeof raw.expiry_time === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(raw.expiry_time)) {
    const date = new Date(raw.expiry_time.replace(' ', 'T') + '+07:00');
    if (Number.isFinite(date.getTime())) details.expiresAt = date;
  }
  return details;
};
