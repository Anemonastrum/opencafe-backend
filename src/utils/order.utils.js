import { createHash } from 'node:crypto';
import { parseCatalogId } from './catalog.utils.js';

export const orderError = (message,status) => Object.assign(new Error(message),{status});
const integer = (value,max) => Number.isInteger(value) && value>0 && value<=max;
const object = value => value && typeof value==='object' && !Array.isArray(value);
export const validateOrder = body => {
  if (!object(body) || Object.keys(body).length!==1 || !Array.isArray(body.items) || !body.items.length || body.items.length>100) return {error:'Supply 1–100 distinct order items'};
  const ids=new Set();
  for (const item of body.items) {
    if (!object(item) || Object.keys(item).length!==2 || !integer(item.productId,2147483647) || !integer(item.quantity,999) || ids.has(item.productId)) return {error:'Each item requires a distinct productId and quantity 1–999'};
    ids.add(item.productId);
  }
  return {data:body.items.map(({productId,quantity})=>({productId,quantity})).sort((a,b)=>a.productId-b.productId)};
};
export const parseOrderQuery = (query,user) => {
  if (Object.keys(query).some(key=>!['page','limit','status','cashierId','orderNumber'].includes(key))) return {error:'Invalid order query fields'};
  const page=query.page===undefined?1:parseCatalogId(query.page),limit=query.limit===undefined?20:parseCatalogId(query.limit);
  if (!page || !limit || limit>100 || (page-1)*limit>2147483647) return {error:'Invalid page or limit'};
  const where=user.role==='ADMIN'?{}:{cashierId:user.id};
  const status=query.status===undefined?'PENDING':query.status;
  if (!['PENDING','CANCELLED','COMPLETED','ALL'].includes(status)) return {error:'Invalid order status'};
  if (status!=='ALL') where.status=status;
  if (query.cashierId!==undefined) {
    const id=parseCatalogId(query.cashierId);
    if (user.role!=='ADMIN' || !id) return {error:'Invalid cashier filter'};
    where.cashierId=id;
  }
  if (query.orderNumber!==undefined) {
    const value=query.orderNumber;
    if (typeof value!=='string' || !value.isWellFormed() || !value.trim() || [...value.trim()].length>50) return {error:'Invalid order number'};
    where.orderNumber=value.trim();
  }
  return {data:{where,page,limit}};
};
const max=999999999999n;
const cents = value => {
  const text=value?.toString();
  if (!text || !/^\d{1,10}(\.\d{1,2})?$/.test(text)) throw orderError('Invalid stored order amounts',409);
  const [whole,fraction='']=text.split('.');
  return BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));
};
const fixed = value => `${value/100n}.${String(value%100n).padStart(2,'0')}`;
const bounded = value => { if (value>max) throw orderError('Order amount exceeds supported limit',400); return value; };
const round = (numerator,denominator) => (numerator+denominator/2n)/denominator;
export const calculateOrder = (items,tax) => {
  const rate=cents(tax.taxRate);
  if (rate>10000n || typeof tax.taxInclusive!=='boolean' || (tax.taxName!==null && (typeof tax.taxName!=='string' || !tax.taxName.trim())) || (rate>0n && !tax.taxName)) throw orderError('Invalid stored tax settings',409);
  let subtotal=0n;
  const lines=items.map(item=>{
    if (!integer(item.quantity,999)) throw orderError('Invalid stored order quantity',409);
    const price=cents(item.unitPrice),amount=bounded(price*BigInt(item.quantity));
    subtotal=bounded(subtotal+amount);
    return {...item,unitPrice:fixed(price),subtotal:fixed(amount)};
  });
  const amount=bounded(round(subtotal*rate,tax.taxInclusive?10000n+rate:10000n));
  return {items:lines,subtotalAmount:fixed(subtotal),taxAmount:fixed(amount),totalAmount:fixed(bounded(subtotal+(tax.taxInclusive?0n:amount)))};
};
export const validateOrderSnapshot = order => {
  try {
    if (!order.items?.length || order.items.length>100 || new Set(order.items.map(i=>i.productId)).size!==order.items.length || order.items.some(i=>!integer(i.productId,2147483647) || typeof i.productName!=='string' || !i.productName.trim())) throw Error();
    const calculated=calculateOrder(order.items,order);
    for (const key of ['subtotalAmount','taxAmount','totalAmount']) if (cents(order[key])!==cents(calculated[key])) throw Error();
    order.items.forEach((item,i)=>{if (cents(item.subtotal)!==cents(calculated.items[i].subtotal)) throw Error();});
  } catch { throw orderError('Order snapshots require reconciliation before editing',409); }
};
// Display stored signed decimals without treating legacy values as valid pricing inputs.
const displayMoney = value => {
  const text=value.toString();
  return text.startsWith('-') ? `-${fixed(cents(text.slice(1)))}` : fixed(cents(text));
};
const money=['subtotalAmount','taxRate','taxAmount','totalAmount'];
const checkoutFields=['id','orderNumber','status','paymentHoldReason','cashierId','receiptCafeName','receiptCafeAddress','receiptLogoUrl','receiptCashierName','receiptPaperSize','taxName','taxInclusive'];
export const checkoutVersion = order => {
  const snapshot=checkoutFields.map(key=>order[key]??null);
  snapshot.push(...money.map(key=>displayMoney(order[key])));
  snapshot.push(...['createdAt','updatedAt','completedAt'].map(key=>order[key]==null?null:new Date(order[key]).toISOString()));
  snapshot.push([...order.items].sort((a,b)=>a.id-b.id).map(item=>[item.id,item.productId,item.productName,displayMoney(item.unitPrice),item.quantity,displayMoney(item.subtotal)]));
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
};
export const serializeOrder = order => {
  const result={};
  for (const key of ['id','orderNumber','status','paymentHoldReason','cashierId','receiptCafeName','receiptCafeAddress','receiptLogoUrl','receiptCashierName','receiptPaperSize','taxName','taxInclusive','createdAt','updatedAt','completedAt',...money]) {
    if (order[key]!==undefined) result[key]=money.includes(key)?displayMoney(order[key]):order[key];
  }
  if (order.items) result.items=order.items.map(item=>({id:item.id,productId:item.productId,productName:item.productName,unitPrice:displayMoney(item.unitPrice),quantity:item.quantity,subtotal:displayMoney(item.subtotal)}));
  if (order._count) result._count={items:order._count.items};
  result.checkoutVersion=order.items?checkoutVersion(order):null;
  return result;
};
export const handleOrderError = (res,error) => {
  if ([400,403,404,409].includes(error.status)) return res.status(error.status).json({message:error.message});
  const mapped={P2002:[409,'Order number conflict; retry request'],P2025:[404,'Order not found'],P2003:[409,'Order reference conflict'],P2034:[409,'Order changed concurrently; retry request']};
  const [status,message]=mapped[error.code]||[500,'Server error'];
  return res.status(status).json({message});
};
