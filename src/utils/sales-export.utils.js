import ExcelJS from 'exceljs';
import { Writable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { SALES_LIMITS, salesError } from './sales-report.utils.js';

export const transactionColumns = ['paymentId', 'orderId', 'orderNumber', 'paidAt', 'businessDate', 'cashierId', 'cashierName', 'method', 'classification', 'reviewReasons', 'originalTotalAmount', 'roundingAdjustment', 'collectedAmount', 'taxAmount', 'netSalesAmount'];
const metrics = ['paidOrderCount', 'unitsSold', 'collectedAmount', 'originalTotalAmount', 'roundingAdjustment', 'taxAmount', 'netSalesAmount'];
const moneyColumns = new Set([...metrics.slice(2), 'unitPrice', 'merchandiseAmount']);
const excessive = () => salesError(422, 'Sales export exceeds limits; narrow filters');
const scalar = value => Array.isArray(value) ? value.join(';') : value ?? '';
const csvCell = (value, key) => {
  let text = String(scalar(value));
  const trustedMoney = moneyColumns.has(key) && /^-?\d+\.\d{2}$/.test(text);
  if (!trustedMoney && (/^[\s]*[=+\-@]/u.test(text) || /^[\s]*[\t\r]/u.test(text))) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
};
export const encodeSalesExport = async (dataset, format, { scope = 'all', signal } = {}) => {
  signal?.throwIfAborted();
  const rows = dataset.transactions.filter(row => scope === 'all' || row.classification === scope);
  let bytes = 0;
  const chunks = [];
  const append = chunk => {
    bytes += chunk.length;
    if (bytes > SALES_LIMITS.outputBytes) throw excessive();
    chunks.push(chunk);
  };
  if (format === 'csv') {
    append(Buffer.from('\uFEFF' + transactionColumns.map(key => csvCell(key, '')).join(',') + '\r\n'));
    for (let i = 0; i < rows.length; i++) {
      signal?.throwIfAborted();
      append(Buffer.from(transactionColumns.map(key => csvCell(rows[i][key], key)).join(',') + '\r\n'));
      if (i % 128 === 0) await setImmediate();
    }
    signal?.throwIfAborted();
    return { buffer: Buffer.concat(chunks), mime: 'text/csv; charset=utf-8', extension: 'csv' };
  }
  if (format !== 'xlsx') throw salesError(400, 'Invalid sales export format');
  const summary = [...Object.entries(dataset.filters), ['scope', scope], ['generatedAt', dataset.generatedAt], ['undatedPaidCount', dataset.review.undatedPaidCount], ...Object.entries(dataset.summary)].map(([metric, value]) => ({ metric, value }));
  const review = ['candidateCount', 'cleanCount', 'reviewCount', 'undatedPaidCount'].map(metric => ({ metric, count: dataset.review[metric] })).concat(dataset.review.reasons.map(row => ({ metric: row.reason, count: row.count })));
  const sheets = [
    ['Summary', ['metric', 'value'], summary],
    ['Daily', ['date', ...metrics], dataset.daily],
    ['Methods', ['method', ...metrics], dataset.methods],
    ['Cashiers', ['cashierId', 'cashierName', ...metrics], dataset.cashiers],
    ['Products', ['productId', 'productName', 'unitPrice', 'unitsSold', 'paidOrderCount', 'merchandiseAmount'], dataset.products],
    ['Transactions', transactionColumns, rows],
    ['Review', ['metric', 'count'], review]
  ];
  const workbook = new ExcelJS.Workbook();
  let expanded = 0, index = 0;
  for (const [name, columns, records] of sheets) {
    const sheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.columns = columns.map(key => ({ header: key, key, width: key.endsWith('Name') ? 28 : 22 }));
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, records.length + 1), column: columns.length } };
    for (const record of records) {
      signal?.throwIfAborted();
      const values = columns.map(key => scalar(record[key]));
      for (const value of values) {
        if (typeof value === 'string' && value.length > 32767) throw excessive();
        // XML escaping and cell markup bounded before compression/materialization.
        expanded += Buffer.byteLength(String(value)) * 6 + 96;
        if (expanded > SALES_LIMITS.outputBytes) throw excessive();
      }
      sheet.addRow(values);
      if (++index % 128 === 0) await setImmediate();
    }
  }
  signal?.throwIfAborted();
  let failure;
  // ponytail: ExcelJS document writer has no abort API; bounded render finishes
  // into discard sink after cancellation/overflow. No abandoned writer promise.
  const destination = new Writable({ write(chunk, encoding, callback) {
    if (!failure) {
      try { signal?.throwIfAborted(); append(chunk); }
      catch (error) { failure = error; chunks.length = 0; }
    }
    callback();
  } });
  destination.on('error', error => { failure ||= error; });
  await workbook.xlsx.write(destination);
  signal?.throwIfAborted();
  if (failure) throw failure;
  return { buffer: Buffer.concat(chunks), mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extension: 'xlsx' };
};
