import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, lstat, open, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import QRCode from 'qrcode';
import { imageConfig } from './image.utils.js';
import { calculateOrder } from './order.utils.js';

import { moneyCents, fixedMoney, paymentAmounts } from './payment.utils.js';

export const paidReceipt = order => {
  const paid = order.payments.filter(payment => payment.status === 'PAID');
  if (paid.length !== 1 || order.payments.some(payment => payment.reconciliationReason || !payment.requestId || payment.orderTotalAmount == null || payment.roundingAdjustment == null || (payment.method === 'CASH' && payment.status === 'PENDING'))) throw receiptError(409);
  receiptData(order, paid[0]);
  return paid[0];
};
export const ensureReceipt = async orderId => {
  const { prisma } = await import('../configs/prisma.js');
  const snapshot = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId} FOR UPDATE`;
    const order = await tx.order.findUnique({where:{id:orderId},include:{items:{orderBy:{id:'asc'}},payments:true}});
    if (!order) throw receiptError(404);
    const payment = paidReceipt(order);
    const paperSize = order.receiptPaperSize || (await tx.cafeSetting.findUnique({where:{id:1}}))?.receiptPaperSize || '58mm';
    if (!['58mm','80mm'].includes(paperSize)) throw receiptError(409);
    const url = order.receiptUrl || receiptLocation(payment.paidAt,imageConfig.base).url;
    const pathname = receiptPathname(url);
    if (!pathname || !url.startsWith('http') || !pathname.startsWith(`/uploads/receipt/${receiptDate(payment.paidAt)}/`)) throw receiptError();
    receiptQr(url);
    if (!order.receiptUrl || !order.receiptPaperSize) await tx.order.update({where:{id:orderId},data:{receiptUrl:url,receiptPaperSize:paperSize}});
    return {data:receiptData(order,payment),paperSize,url,pathname};
  });
  const result={downloadUrl:snapshot.url,paperSize:snapshot.paperSize};
  try {await readReceipt(snapshot.pathname);return {created:false,...result};}
  catch(error){if(error.status!==404)throw error;}
  const {renderReceipt}=await import('../assets/receipt.template.js');
  const buffer=await renderReceipt(snapshot.data,snapshot.paperSize,snapshot.url);
  return {created:await publishReceipt(snapshot.pathname,buffer),...result};
};
export const tryGenerateReceipt = async orderId => {
  try {await ensureReceipt(orderId);}
  catch {console.error('Receipt generation unavailable',orderId);}
};

export const receiptError = (status = 503) => Object.assign(new Error(status === 409 ? 'Receipt snapshots require reconciliation' : status === 404 ? 'Receipt not found; generate it with POST first' : 'Receipt unavailable; retry later'), { status });
const pattern = /^\/uploads\/receipt\/(\d{4}-\d{2}-\d{2})\/([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.pdf$/;
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= '1000-01-01' && value <= '9999-12-31' && new Date(value+'T00:00:00Z').toISOString().slice(0,10) === value;
export const receiptDate = value => {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw receiptError(409);
  const parts = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Jakarta',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(value);
  const date = ['year','month','day'].map(type=>parts.find(p=>p.type===type).value).join('-');
  if (!validDate(date)) throw receiptError(409);
  return date;
};
export const receiptPathname = value => {
  if (typeof value !== 'string' || value.length > 500) return null;
  let pathname = value;
  if (!value.startsWith('/')) {
    try { const u = new URL(value); if (!['http:','https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || u.origin+u.pathname !== value) return null; pathname=u.pathname; }
    catch { return null; }
  }
  const match = pattern.exec(pathname);
  try { return match && validDate(match[1]) ? pathname : null; } catch { return null; }
};
export const receiptQr = url => {
  if (!receiptPathname(url) || !url.startsWith('http')) throw receiptError();
  const qr = QRCode.create(url, {errorCorrectionLevel:'M'});
  if (qr.version > 10) throw receiptError();
  return qr.modules;
};
export const receiptLocation = (paidAt, base, uuid = randomUUID()) => {
  const origin = new URL(base);
  if (!['http:','https:'].includes(origin.protocol) || origin.origin !== base || origin.username || origin.password || (process.env.NODE_ENV === 'production' && origin.protocol !== 'https:')) throw receiptError();
  const pathname = `/uploads/receipt/${receiptDate(paidAt)}/${uuid}.pdf`, url = base+pathname;
  if (!receiptPathname(url)) throw receiptError();
  receiptQr(url);
  return {url,pathname,path:path.join(imageConfig.root,pathname.slice('/uploads/'.length))};
};
const text = (value, limit, fallback = 'Unavailable') => {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string' || !value.isWellFormed() || Buffer.byteLength(value)>limit) throw receiptError(409);
  return value.trim() || fallback;
};
export const receiptData = (order, payment) => {
  try {
    if (order.status !== 'COMPLETED' || order.paymentHoldReason || payment.status !== 'PAID' || payment.reconciliationReason || payment.orderId !== order.id || !['CASH','QRIS'].includes(payment.method)) throw Error();
    receiptDate(order.createdAt); receiptDate(order.completedAt); receiptDate(payment.paidAt);
    if (!order.items?.length || order.items.length>100) throw Error();
    const calculated = calculateOrder(order.items,order);
    for (const key of ['subtotalAmount','taxAmount','totalAmount']) if (moneyCents(order[key]) !== moneyCents(calculated[key])) throw Error();
    order.items.forEach((item,i)=>{if(moneyCents(item.subtotal)!==moneyCents(calculated.items[i].subtotal))throw Error();});
    const expected = paymentAmounts(order.totalAmount);
    const adjustment = String(payment.roundingAdjustment);
    const signed = adjustment.startsWith('-') ? -moneyCents(adjustment.slice(1)) : moneyCents(adjustment);
    if (moneyCents(payment.orderTotalAmount)!==moneyCents(order.totalAmount) || moneyCents(payment.amount)!==moneyCents(expected.amount) || fixedMoney(signed)!==expected.roundingAdjustment) throw Error();
    const paid = {method:payment.method,amount:expected.amount,roundingAdjustment:expected.roundingAdjustment,paidAt:payment.paidAt.toISOString()};
    if (payment.method === 'CASH') {
      const received=moneyCents(payment.cashReceived),change=moneyCents(payment.changeAmount);
      if (received-moneyCents(payment.amount)!==change) throw Error();
      paid.cashReceived=fixedMoney(received); paid.changeAmount=fixedMoney(change);
    }
    return {logoUrl:order.receiptLogoUrl,orderNumber:text(order.orderNumber,200),cafeName:text(order.receiptCafeName,600),address:text(order.receiptCafeAddress,65535),cashierName:text(order.receiptCashierName,400),createdAt:order.createdAt.toISOString(),items:order.items.map(i=>({productName:text(i.productName,600),quantity:i.quantity,unitPrice:fixedMoney(moneyCents(i.unitPrice)),subtotal:fixedMoney(moneyCents(i.subtotal))})),subtotal:fixedMoney(moneyCents(order.subtotalAmount)),taxName:text(order.taxName,200,'Tax'),taxRate:fixedMoney(moneyCents(order.taxRate)),taxInclusive:order.taxInclusive,taxAmount:fixedMoney(moneyCents(order.taxAmount)),total:fixedMoney(moneyCents(order.totalAmount)),payment:paid};
  } catch { throw receiptError(409); }
};
const targetPath = async (pathname, create = false) => {
  if (!receiptPathname(pathname) || !pathname.startsWith('/')) throw receiptError();
  const file = path.join(imageConfig.root,pathname.slice('/uploads/'.length));
  const dirs=[imageConfig.root,path.join(imageConfig.root,'receipt'),path.dirname(file)];
  for(const dir of dirs) {
    if(create)await mkdir(dir,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});
    const stat=await lstat(dir);if(!stat.isDirectory()||stat.isSymbolicLink())throw receiptError();
  }
  return file;
};
const validPdf = buffer => buffer.length <= 8*1024*1024 && buffer.subarray(0,5).toString()==='%PDF-' && /%%EOF\s*$/.test(buffer.subarray(-64).toString());
export const readReceipt = async pathname => {
  let file;
  try {
    file=await open(await targetPath(pathname),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const stat=await file.stat();if(!stat.isFile()||stat.size>8*1024*1024)throw receiptError();
    const buffer=await file.readFile();if(!validPdf(buffer))throw receiptError();return buffer;
  } catch(e) {throw receiptError(e.code==='ENOENT'?404:503);} finally {await file?.close();}
};
export const publishReceipt = async (pathname, buffer) => {
  if(!Buffer.isBuffer(buffer)||!validPdf(buffer))throw receiptError();
  let temporary;
  try {
    const destination=await targetPath(pathname,true);temporary=destination+'.'+randomUUID()+'.tmp';
    const file=await open(temporary,'wx',0o600);
    try {await file.writeFile(buffer);}finally{await file.close();}
    try {await link(temporary,destination);return true;}
    catch(e){if(e.code!=='EEXIST')throw e;await readReceipt(pathname);return false;}
  } catch {throw receiptError();} finally {if(temporary)await unlink(temporary).catch(()=>{});}
};
