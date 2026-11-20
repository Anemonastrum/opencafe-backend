import { prisma } from '../configs/prisma.js';
import { validSession } from '../utils/session.utils.js';
import { encodeSalesExport } from '../utils/sales-export.utils.js';
let activeExports = 0;
const sendAttachment = (res, buffer) => new Promise((resolve, reject) => {
  const finish = () => { cleanup(); resolve(); };
  const error = err => { cleanup(); reject(err); };
  const cleanup = () => { res.off('finish', finish); res.off('close', finish); res.off('error', error); };
  res.once('finish', finish); res.once('close', finish); res.once('error', error);
  res.end(buffer);
});
import { parseSalesQuery, loadSalesReport, salesError } from '../utils/sales-report.utils.js';

const requireLiveReportAdmin = async req => {
  const session = await prisma.authSession.findUnique({ where: { id: req.authSession }, include: { user: true } });
  if (!validSession(session, session?.user) || session.userId !== req.user.id) throw salesError(401, 'Session expired or revoked');
  if (session.user.role !== 'ADMIN' || session.user.mustChangePassword) throw salesError(403, 'Administrator permission required');
};
const reportError = (res, error) => {
  const status = [400, 401, 403, 422, 503].includes(error.status) ? error.status : 503;
  if (!res.destroyed && !res.headersSent) return res.status(status).json({ message: status === 503 ? 'Sales report unavailable; retry later' : error.message });
};
export const salesTransactions = (dataset, scope) => dataset.transactions.filter(row => scope === 'all' || row.classification === scope);
const serveReport = async (req, res, kind) => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once('aborted', abort); res.once('close', abort);
  let admitted = false;
  try {
    const filters = parseSalesQuery(req.originalUrl, kind);
    if (kind === 'export') {
      if (activeExports >= 2) throw salesError(503, 'Sales report unavailable; retry later');
      activeExports++; admitted = true;
    }
    await requireLiveReportAdmin(req);
    const dataset = await loadSalesReport(prisma, filters, { signal: controller.signal });
    if (kind === 'export') {
      const output = await encodeSalesExport(dataset, filters.format, { scope: filters.scope, signal: controller.signal });
      await requireLiveReportAdmin(req);
      controller.signal.throwIfAborted();
      const filename = `sales_${filters.from}_${filters.to}_${filters.method || 'ALL'}_${filters.cashierId || 'ALL'}_${filters.scope}.${output.extension}`;
      res.set({ 'Content-Type': output.mime, 'Content-Disposition': `attachment; filename="${filename}"`, 'Content-Length': String(output.buffer.length) });
      await sendAttachment(res, output.buffer);
      return;
    }
    await requireLiveReportAdmin(req);
    controller.signal.throwIfAborted();
    if (kind === 'summary') {
      const { transactions, ...report } = dataset;
      return res.json(report);
    }
    const rows = salesTransactions(dataset, filters.scope);
    return res.json({ filters: { ...dataset.filters, scope: filters.scope }, generatedAt: dataset.generatedAt, transactions: rows.slice((filters.page - 1) * filters.limit, filters.page * filters.limit), total: rows.length, page: filters.page, limit: filters.limit });
  } catch (error) { return reportError(res, error); }
  finally { if (admitted) activeExports--; req.off('aborted', abort); res.off('close', abort); }
};
export const exportSalesReport = (req, res) => serveReport(req, res, 'export');
export const getSalesReport = (req, res) => serveReport(req, res, 'summary');
export const listSalesTransactions = (req, res) => serveReport(req, res, 'transactions');
