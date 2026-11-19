import { prisma } from '../configs/prisma.js';
import { randomUUID } from 'node:crypto';
import { midtransConfig, chargeQris, getQrisStatus, providerObservation, qrisDetails, validNotification, verifyMidtransNotification } from '../utils/midtrans.utils.js';
import { withUserLock, validSession } from '../utils/session.utils.js';
import { parseCatalogId } from '../utils/catalog.utils.js';
import { validateOrderSnapshot, serializeOrder } from '../utils/order.utils.js';
import { paymentError, handlePaymentError, validatePayment, paymentAmounts, validateQrisAmount, moneyCents, fixedMoney, samePaymentRequest, serializePayment, legacyPaymentHold } from '../utils/payment.utils.js';

const include = { items: { orderBy: { id: 'asc' } } };
const checkActor = async (tx, req, user) => {
  const session = await tx.authSession.findUnique({ where: { id: req.authSession } });
  if (!validSession(session, user) || !['ADMIN', 'CASHIER'].includes(user.role) || user.mustChangePassword) throw paymentError('Payment permission required', 403);
};
const owned = (order, user) => {
  if (!order || (user.role !== 'ADMIN' && order.cashierId !== user.id)) throw paymentError('Order not found', 404);
  return order;
};
const withPaymentActor = (req, orderId, callback) => withUserLock(req.user.id, async (tx, user) => {
  await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId} FOR UPDATE`;
  await checkActor(tx, req, user);
  const order = owned(await tx.order.findUnique({ where: { id: orderId }, include }), user);
  order.paymentHoldReason ||= await legacyPaymentHold(tx, orderId);
  return callback(tx, order, user);
});
const response = (res, result, status = 200) => res.status(status).json({ message: result.payment.status === 'PAID' ? 'Payment completed successfully' : 'Payment recorded', order: serializeOrder(result.order), payment: serializePayment(result.payment) });

export const createPayment = async (req, res) => {
  const id = parseCatalogId(req.params.id);
  if (!id) return res.status(400).json({ message: 'Invalid order ID' });
  const { data, error } = validatePayment(req.body);
  if (error) return res.status(400).json({ message: error });
  try {
    const result = await withPaymentActor(req, id, async (tx, order) => {
      const replay = await tx.payment.findUnique({ where: { orderId_requestId: { orderId: id, requestId: data.requestId } } });
      if (replay) {
        if (!samePaymentRequest(replay, data)) throw paymentError('requestId was already used with different payment fields', 409);
        return { order, payment: replay, replay: true };
      }
      if (order.paymentHoldReason || order.status !== 'PENDING' || await tx.payment.count({ where: { orderId: id, status: { in: ['PENDING', 'PAID'] } } })) throw paymentError('Order cannot accept payment in its current state', 409);
      validateOrderSnapshot(order);
      const amounts = paymentAmounts(order.totalAmount);
      if (data.method === 'QRIS') { validateQrisAmount(amounts); midtransConfig(); }
      const received = data.method === 'CASH' ? moneyCents(data.cashReceived) : 0n, payable = moneyCents(amounts.amount);
      if (data.method === 'CASH' && received < payable) throw paymentError('cashReceived is less than payable amount', 400);
      const last = await tx.payment.findFirst({ where: { orderId: id }, orderBy: { attemptNumber: 'desc' } });
      const attemptNumber = (last?.attemptNumber || 0) + 1;
      if (attemptNumber > 2147483647) throw paymentError('Payment attempt limit reached', 409);
      const now = new Date();
      const { grossAmount, ...snapshot } = amounts;
      if (data.method === 'QRIS') {
        const payment = await tx.payment.create({ data: { orderId: id, requestId: data.requestId, attemptNumber, method: 'QRIS', status: 'PENDING', ...snapshot, midtransOrderId: `OC-${randomUUID()}`, dispatchClaimedAt: now } });
        return { order, payment, shouldDispatch: true };
      }
      const payment = await tx.payment.create({ data: { orderId: id, requestId: data.requestId, attemptNumber, method: 'CASH', status: 'PAID', ...snapshot, cashReceived: data.cashReceived, changeAmount: fixedMoney(received - payable), paidAt: now } });
      const completed = await tx.order.update({ where: { id }, data: { status: 'COMPLETED', completedAt: now }, include });
      return { order: completed, payment };
    });
    if (result.shouldDispatch) {
      let details = {}, chargeObservation;
      await withPaymentActor(req, id, async () => {});
      try {
        const raw = await chargeQris(result.payment);
        chargeObservation = providerObservation(raw);
        if (chargeObservation.order_id === result.payment.midtransOrderId && chargeObservation.payment_type === 'qris' && chargeObservation.currency === 'IDR' && moneyCents(chargeObservation.gross_amount) === moneyCents(result.payment.amount) && (!chargeObservation.fraud_status || chargeObservation.fraud_status === 'accept')) details = qrisDetails(raw);
      } catch { /* The reserved attempt remains unresolved; never resend. */ }
      await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM orders WHERE id = ${id} FOR UPDATE`;
        await tx.payment.update({ where: { id: result.payment.id }, data: { dispatchFinishedAt: new Date(), ...details } });
      });
      if (chargeObservation) await applyProviderObservation(result.payment.id, chargeObservation, false);
      try { await refreshPayment(result.payment); }
      catch (error) { if (error.status !== 502) throw error; }
    }
    const current = await withPaymentActor(req, id, async (tx, order) => ({ order, payment: await tx.payment.findUnique({ where: { id: result.payment.id } }) }));
    const status = current.order.paymentHoldReason ? 409 : current.payment.method === 'QRIS' && current.payment.status === 'PENDING' && !current.payment.qrisQrUrl && !current.payment.qrisPayload ? 202 : result.replay ? 200 : 201;
    return response(res, current, status);
  } catch (error) { return handlePaymentError(res, error); }
};
// Verified provider evidence is system-owned; employee revocation must not discard it.
const applyProviderObservation = async (paymentId, observation, dispatchFinishedBeforeLookup) => {
  for (let retry = 0; retry < 3; retry++) {
    const found = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (!found) throw paymentError('Payment not found', 404);
    const binding = await prisma.payment.findUnique({ where: { midtransTransactionId: observation.transaction_id } });
    const orderIds = [...new Set([found.orderId, ...(binding ? [binding.orderId] : [])])].sort((a, b) => a - b);
    try {
      return await prisma.$transaction(async tx => {
        for (const id of orderIds) await tx.$queryRaw`SELECT id FROM orders WHERE id = ${id} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM payments WHERE id = ${paymentId} FOR UPDATE`;
        const payment = await tx.payment.findUnique({ where: { id: paymentId } });
        const order = await tx.order.findUnique({ where: { id: payment.orderId }, include });
        const currentBinding = await tx.payment.findUnique({ where: { midtransTransactionId: observation.transaction_id } });
        if (currentBinding && !orderIds.includes(currentBinding.orderId)) throw Object.assign(Error('Binding changed'), { retryBinding: true });
        const patch = { latestProviderObservation: observation, midtransStatus: observation.transaction_status };
        if (observation.transaction_status === 'settlement' && !payment.settlementObservation) patch.settlementObservation = observation;
        let reason = null;
        if (currentBinding && currentBinding.id !== paymentId) reason = 'PROVIDER_TRANSACTION_ID_CONFLICT';
        else if (payment.midtransTransactionId && payment.midtransTransactionId !== observation.transaction_id) reason = 'PROVIDER_IDENTITY_MISMATCH';
        else if (observation.order_id !== payment.midtransOrderId || observation.payment_type !== 'qris' || observation.currency !== 'IDR') reason = 'PROVIDER_IDENTITY_MISMATCH';
        else {
          try { if (moneyCents(observation.gross_amount) !== moneyCents(payment.amount)) reason = 'PROVIDER_AMOUNT_MISMATCH'; }
          catch { reason = 'PROVIDER_AMOUNT_MISMATCH'; }
        }
        if (!payment.requestId || payment.orderTotalAmount === null || payment.roundingAdjustment === null || !payment.dispatchClaimedAt) reason ||= 'LEGACY_PAYMENT_REQUIRES_RECONCILIATION';
        if (!reason && payment.status === 'PENDING') {
          try {
            validateOrderSnapshot(order);
            const expected = paymentAmounts(order.totalAmount);
            if (moneyCents(payment.orderTotalAmount) !== moneyCents(order.totalAmount) || moneyCents(payment.amount) !== moneyCents(expected.amount) || payment.roundingAdjustment.toFixed(2) !== expected.roundingAdjustment) reason = 'PAYMENT_SNAPSHOT_MISMATCH';
          } catch { reason = 'PAYMENT_SNAPSHOT_MISMATCH'; }
        }
        if (observation.fraud_status !== undefined && observation.fraud_status !== 'accept') reason ||= 'PROVIDER_FRAUD_REVIEW';
        if (!['pending', 'settlement', 'expire', 'deny', 'cancel'].includes(observation.transaction_status)) reason ||= 'UNSUPPORTED_PROVIDER_STATUS';
        if (!reason) patch.midtransTransactionId = observation.transaction_id;
        if (!reason && observation.transaction_status === 'settlement' && payment.status !== 'PAID') {
          const competing = await tx.payment.count({ where: { orderId: payment.orderId, id: { not: paymentId }, status: { in: ['PENDING', 'PAID'] } } });
          if (payment.status !== 'PENDING' || order.status !== 'PENDING' || order.paymentHoldReason || payment.reconciliationReason || competing) reason = 'SETTLEMENT_REQUIRES_RECONCILIATION';
          else {
            const now = new Date();
            patch.status = 'PAID'; patch.paidAt = now;
            await tx.order.update({ where: { id: order.id }, data: { status: 'COMPLETED', completedAt: now } });
          }
        }
        if (!reason && payment.status === 'PENDING' && !order.paymentHoldReason && !payment.reconciliationReason && dispatchFinishedBeforeLookup && payment.dispatchFinishedAt && ['expire', 'deny', 'cancel'].includes(observation.transaction_status)) patch.status = observation.transaction_status === 'expire' ? 'EXPIRED' : 'FAILED';
        if (reason) {
          patch.reconciliationReason = payment.reconciliationReason || reason;
          for (const id of orderIds) {
            const held = await tx.order.findUnique({ where: { id } });
            if (!held.paymentHoldReason) await tx.order.update({ where: { id }, data: { paymentHoldReason: reason } });
          }
          if (currentBinding && currentBinding.id !== paymentId && !currentBinding.reconciliationReason) await tx.payment.update({ where: { id: currentBinding.id }, data: { reconciliationReason: reason } });
        }
        const updated = await tx.payment.update({ where: { id: paymentId }, data: patch });
        return { payment: updated, order: await tx.order.findUnique({ where: { id: order.id }, include }) };
      }, { isolationLevel: 'ReadCommitted' });
    } catch (error) {
      if ((error.retryBinding || error.code === 'P2002') && retry < 2) continue;
      throw error;
    }
  }
};
const refreshPayment = async payment => {
  const current = await prisma.payment.findUnique({ where: { id: payment.id } });
  const finishedBeforeLookup = Boolean(current.dispatchFinishedAt);
  const observation = providerObservation(await getQrisStatus(current));
  return applyProviderObservation(current.id, observation, finishedBeforeLookup);
};
const noFields = req => {
  const hasBody = Number(req.headers['content-length']) > 0 || req.headers['transfer-encoding'];
  return !hasBody || (req.is('application/json') && req.body && typeof req.body === 'object' && !Array.isArray(req.body) && !Object.keys(req.body).length);
};
export const reconcilePayment = async (req, res) => {
  const id = parseCatalogId(req.params.id), paymentId = parseCatalogId(req.params.paymentId);
  if (!id || !paymentId || !noFields(req) || Object.keys(req.query).length) return res.status(400).json({ message: 'Invalid reconciliation request' });
  try {
    const payment = await withPaymentActor(req, id, async tx => {
      const payment = await tx.payment.findFirst({ where: { id: paymentId, orderId: id } });
      if (!payment) throw paymentError('Payment not found', 404);
      if (payment.method !== 'QRIS' || !payment.midtransOrderId) throw paymentError('Only QRIS payments support provider reconciliation', 409);
      return payment;
    });
    await refreshPayment(payment);
    const result = await withPaymentActor(req, id, async (tx, order) => ({ order, payment: await tx.payment.findUnique({ where: { id: paymentId } }) }));
    return response(res, result, result.order.paymentHoldReason ? 409 : result.payment.status === 'PENDING' ? 202 : 200);
  } catch (error) { return handlePaymentError(res, error); }
};
export const midtransNotification = async (req, res) => {
  if (!validNotification(req.body)) return res.status(400).json({ message: 'Invalid Midtrans notification' });
  try {
    if (!verifyMidtransNotification(req.body, midtransConfig().signatureSecretKey)) return res.status(403).json({ message: 'Invalid Midtrans signature' });
    const payment = await prisma.payment.findUnique({ where: { midtransOrderId: req.body.order_id } });
    if (!payment || payment.method !== 'QRIS') return res.status(404).json({ message: 'Payment not found' });
    await refreshPayment(payment);
    return res.json({ message: 'Notification processed' });
  } catch { return res.status(503).json({ message: 'Notification processing unavailable; retry later' }); }
};
export const listPayments = async (req, res) => {
  const id = parseCatalogId(req.params.id);
  if (!id || Object.keys(req.query).length) return res.status(400).json({ message: 'Invalid order ID or payment query' });
  try {
    const result = await withPaymentActor(req, id, async (tx, order) => ({ order, payments: await tx.payment.findMany({ where: { orderId: id }, orderBy: { attemptNumber: 'asc' } }) }));
    return res.json({ order: serializeOrder(result.order), payments: result.payments.map(serializePayment) });
  } catch (error) { return handlePaymentError(res, error); }
};
