import { loadSalesReport, parseSalesQuery } from './sales-report.utils.js';
import { boundedNotificationJson, notificationError, retryNotificationTransaction } from './notification.utils.js';

const dayMs = 86400000;
const dateKey = value => value instanceof Date ? value.toISOString().slice(0, 10) : value;
export const pendingReportDates = (latestBusinessDate, now) => {
  const today = new Date(now.getTime() + 7 * 3600000).toISOString().slice(0, 10);
  const yesterday = Date.parse(today + 'T00:00:00Z') - dayMs;
  const first = latestBusinessDate ? Date.parse(dateKey(latestBusinessDate) + 'T00:00:00Z') + dayMs : yesterday;
  const dates = [];
  for (let time = first; time <= yesterday && dates.length < 7; time += dayMs) dates.push(new Date(time).toISOString().slice(0, 10));
  return dates;
};
export const generateDailyNotificationReport = async (db, businessDate, { signal } = {}) => {
  const filters = parseSalesQuery(`/?from=${businessDate}&to=${businessDate}`, 'summary');
  const where = { businessDate: new Date(businessDate + 'T00:00:00Z') };
  signal?.throwIfAborted();
  const existing = await db.dailyNotificationReport.findUnique({ where });
  if (existing) return existing;
  let status = 'READY', data, generatedAt = new Date();
  try {
    const report = await loadSalesReport(db, filters, { signal, generatedAt });
    generatedAt = new Date(report.generatedAt);
    data = { summary: report.summary, review: report.review, filters: report.filters };
  } catch (error) {
    if (error.status !== 422) throw error;
    status = 'UNAVAILABLE'; data = { reason: 'REPORT_LIMIT_EXCEEDED' };
  }
  boundedNotificationJson(data, 65536);
  const save = () => db.$transaction(async tx => {
    signal?.throwIfAborted();
    const saved = await tx.dailyNotificationReport.findUnique({ where });
    if (saved) return saved;
    const admins = await tx.user.findMany({ where: { role: 'ADMIN', isActive: true, mustChangePassword: false }, select: { id: true }, take: 1001, orderBy: { id: 'asc' } });
    if (admins.length > 1000) throw notificationError(503);
    const report = await tx.dailyNotificationReport.create({ data: { ...where, generatedAt, status, data } });
    if (admins.length) await tx.notification.createMany({ data: admins.map(user => ({ recipientUserId: user.id, type: status === 'READY' ? 'DAILY_SALES_REPORT' : 'DAILY_SALES_REPORT_UNAVAILABLE', eventKey: `daily:${businessDate}`, reportId: report.id, data: boundedNotificationJson({ businessDate, reportId: String(report.id) }) })) });
    signal?.throwIfAborted();
    return report;
  }, { isolationLevel: 'ReadCommitted', timeout: 10000 });
  try { return await retryNotificationTransaction(save); }
  catch (error) {
    // Date uniqueness elects one committed snapshot; no partial recipient delivery.
    if (error.code === 'P2002') {
      const winner = await db.dailyNotificationReport.findUnique({ where });
      if (winner) return winner;
    }
    throw error;
  }
};
export const runNotificationSchedule = async (db, { now = new Date(), signal } = {}) => {
  const latest = await db.dailyNotificationReport.findFirst({ orderBy: { businessDate: 'desc' }, select: { businessDate: true } });
  signal?.throwIfAborted();
  // Store activation before computing; failed first date survives midnight/restart.
  const state = await db.notificationScheduleState.upsert({ where: { id: 1 }, update: {}, create: { id: 1, firstBusinessDate: new Date(pendingReportDates(null, now)[0] + 'T00:00:00Z') } });
  const baseline = latest?.businessDate || new Date(state.firstBusinessDate.getTime() - dayMs);
  for (const date of pendingReportDates(baseline, now)) {
    signal?.throwIfAborted();
    await generateDailyNotificationReport(db, date, { signal });
  }
};
export const startNotificationScheduler = (db, { now = () => new Date(), intervalMs = 60000, onError = () => console.error('Daily notifications unavailable; retry next tick'), run = runNotificationSchedule } = {}) => {
  const controller = new AbortController();
  let active, stopped = false;
  const tick = () => {
    if (stopped || active) return;
    active = Promise.resolve().then(() => run(db, { now: now(), signal: controller.signal })).catch(() => { if (!stopped) onError(); }).finally(() => { active = undefined; });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref(); tick();
  return { timer, stop: async () => { stopped = true; clearInterval(timer); controller.abort(); await active; } };
};
