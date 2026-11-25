import { prisma } from '../configs/prisma.js';
import { validSession, withUserLock } from '../utils/session.utils.js';
import { boundedNotificationJson, notificationError, parseNotificationQuery, retryNotificationTransaction } from '../utils/notification.utils.js';

const liveActor = async (db, req, user) => {
  const session = await db.authSession.findUnique({ where: { id: req.authSession }, include: { user: true } });
  user ||= session?.user;
  if (!validSession(session, user) || session.userId !== req.user.id) throw notificationError(401, 'Session expired or revoked');
  if (user.mustChangePassword || !['ADMIN', 'CASHIER'].includes(user.role) || user.role !== req.user.role) throw notificationError(403, 'Notification permission required');
  return user;
};
const visible = user => ({ recipientUserId: user.id, ...(user.role === 'ADMIN' ? {} : { type: 'PAYMENT_SUCCESS' }) });
const serialize = row => ({ id: String(row.id), type: row.type, data: row.report ? boundedNotificationJson({ businessDate: row.report.businessDate.toISOString().slice(0, 10), reportId: String(row.report.id), status: row.report.status, generatedAt: row.report.generatedAt.toISOString(), ...row.report.data }, 65536 + 1024) : boundedNotificationJson(row.data), readAt: row.readAt?.toISOString() || null, createdAt: row.createdAt.toISOString() });
const serve = async (req, res, kind) => {
  try {
    const filters = parseNotificationQuery(req.originalUrl, kind);
    const hasBody = Number(req.headers['content-length']) > 0 || req.headers['transfer-encoding'];
    if (hasBody && (req.method === 'GET' || !req.is('application/json') || !req.body || Array.isArray(req.body) || typeof req.body !== 'object' || Object.keys(req.body).length)) throw notificationError(400, 'Invalid notification request');
    const id = kind === 'read' ? req.params.id : null;
    if (id !== null && (!/^[1-9]\d{0,9}$/.test(id) || Number(id) > 2147483647)) throw notificationError(400, 'Invalid notification ID');
    const user = await liveActor(prisma, req);
    let result;
    if (kind === 'list' || kind === 'count') {
      result = await prisma.$transaction(async tx => {
        const where = { ...visible(user), ...(kind === 'count' || filters.unread === true ? { readAt: null } : filters.unread === false ? { readAt: { not: null } } : {}) };
        const total = await tx.notification.count({ where });
        if (kind === 'count') return { unreadCount: total };
        const rows = await tx.notification.findMany({ where, orderBy: { id: 'desc' }, skip: (filters.page - 1) * filters.limit, take: filters.limit, include: { report: true } });
        return { notifications: rows.map(serialize), total, page: filters.page, limit: filters.limit };
      }, { isolationLevel: 'RepeatableRead' });
      await liveActor(prisma, req);
    } else {
      result = await retryNotificationTransaction(() => withUserLock(user.id, async (tx, lockedUser) => {
        await liveActor(tx, req, lockedUser);
        const where = visible(lockedUser);
        if (kind === 'all') {
          const { count } = await tx.notification.updateMany({ where: { ...where, readAt: null }, data: { readAt: new Date() } });
          return { message: 'Notifications marked read', updatedCount: count };
        }
        const row = await tx.notification.findFirst({ where: { ...where, id: Number(id) } });
        if (!row) throw notificationError(404, 'Notification not found');
        await tx.notification.updateMany({ where: { ...where, id: row.id, readAt: null }, data: { readAt: new Date() } });
        return { message: 'Notification marked read', notification: serialize(await tx.notification.findUnique({ where: { id: row.id }, include: { report: true } })) };
      }));
      await liveActor(prisma, req);
    }
    return res.json(result);
  } catch (error) {
    const status = [400, 401, 403, 404].includes(error.status) ? error.status : 503;
    return res.status(status).json({ message: status === 503 ? 'Notifications unavailable; retry later' : error.message });
  }
};
export const listNotifications = (req, res) => serve(req, res, 'list');
export const getUnreadNotificationCount = (req, res) => serve(req, res, 'count');
export const markNotificationRead = (req, res) => serve(req, res, 'read');
export const markAllNotificationsRead = (req, res) => serve(req, res, 'all');
