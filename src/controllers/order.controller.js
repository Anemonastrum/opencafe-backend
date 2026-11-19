import { randomUUID } from 'node:crypto';
import { prisma } from '../configs/prisma.js';
import { withUserLock, validSession } from '../utils/session.utils.js';
import { parseCatalogId } from '../utils/catalog.utils.js';
import { legacyPaymentHold } from '../utils/payment.utils.js';
import { validateOrder, parseOrderQuery, calculateOrder, validateOrderSnapshot, serializeOrder, orderError, handleOrderError } from '../utils/order.utils.js';

const include={items:{orderBy:{id:'asc'}}};
const withActor = (req,callback) => withUserLock(req.user.id,async(tx,user)=>{
  const session=await tx.authSession.findUnique({where:{id:req.authSession}});
  if (!validSession(session,user) || !['ADMIN','CASHIER'].includes(user.role) || user.mustChangePassword) throw orderError('Order permission required',403);
  return callback(tx,user);
});
const owned = (order,user) => {
  if (!order || (user.role!=='ADMIN' && order.cashierId!==user.id)) throw orderError('Order not found',404);
  return order;
};
const lockedOrder = async(tx,id,user)=>{
  await tx.$queryRaw`SELECT id FROM orders WHERE id = ${id} FOR UPDATE`;
  return owned(await tx.order.findUnique({where:{id},include}),user);
};
const editable = async(tx,order)=>{
  if (order.paymentHoldReason || await legacyPaymentHold(tx,order.id) || order.status!=='PENDING' || await tx.payment.count({where:{orderId:order.id,status:{in:['PENDING','PAID']}}})) throw orderError('Order cannot be changed in its current state',409);
};
const newLines = async(tx,selection,existing=[])=>{
  const lines=[];
  for (const item of selection) {
    const captured=existing.find(line=>line.productId===item.productId);
    if (captured) { lines.push({productId:item.productId,productName:captured.productName,unitPrice:captured.unitPrice,quantity:item.quantity}); continue; }
    await tx.$queryRaw`SELECT id FROM products WHERE id = ${item.productId} FOR UPDATE`;
    const product=await tx.product.findUnique({where:{id:item.productId}});
    if (!product?.isAvailable) throw orderError('Product not found or unavailable',400);
    lines.push({productId:product.id,productName:product.name,unitPrice:product.price,quantity:item.quantity});
  }
  return lines;
};
export const createOrder = async(req,res)=>{
  const {data,error}=validateOrder(req.body);
  if (error) return res.status(400).json({message:error});
  try {
    const order=await withActor(req,async(tx,user)=>{
      await tx.$queryRaw`SELECT id FROM cafe_settings WHERE id = 1 FOR UPDATE`;
      const cafe=await tx.cafeSetting.findUnique({where:{id:1}});
      if (!cafe) throw orderError('Cafe settings required before taking orders',409);
      const tax=cafe.taxEnabled?{taxName:cafe.taxName,taxRate:cafe.taxRate,taxInclusive:cafe.taxInclusive}:{taxName:null,taxRate:'0.00',taxInclusive:false};
      const {items,...amounts}=calculateOrder(await newLines(tx,data),tax);
      return tx.order.create({data:{orderNumber:`OC-${randomUUID()}`,status:'PENDING',cashierId:user.id,receiptCashierName:user.name,receiptCafeName:cafe.name,receiptCafeAddress:cafe.address,receiptLogoUrl:cafe.logoUrl,receiptPaperSize:cafe.receiptPaperSize,...tax,...amounts,items:{create:items}},include});
    });
    return res.status(201).json({message:'Order created successfully',order:serializeOrder(order)});
  } catch(error) { return handleOrderError(res,error); }
};
export const listOrders = async(req,res)=>{
  const {data,error}=parseOrderQuery(req.query,req.user);
  if (error) return res.status(400).json({message:error});
  const {where,page,limit}=data;
  try {
    const [orders,total]=await prisma.$transaction([prisma.order.findMany({where,include:{_count:{select:{items:true}}},orderBy:[{createdAt:'desc'},{id:'desc'}],skip:(page-1)*limit,take:limit}),prisma.order.count({where})],{isolationLevel:'RepeatableRead'});
    return res.json({orders:orders.map(serializeOrder),total,page,limit});
  } catch(error) { return handleOrderError(res,error); }
};
export const getOrder = async(req,res)=>{
  const id=parseCatalogId(req.params.id);
  if (!id) return res.status(400).json({message:'Invalid order ID'});
  try { return res.json(serializeOrder(owned(await prisma.order.findUnique({where:{id},include}),req.user))); }
  catch(error) { return handleOrderError(res,error); }
};
export const updateOrder = async(req,res)=>{
  const id=parseCatalogId(req.params.id);
  if (!id) return res.status(400).json({message:'Invalid order ID'});
  const {data,error}=validateOrder(req.body);
  if (error) return res.status(400).json({message:error});
  try {
    const order=await withActor(req,async(tx,user)=>{
      const current=await lockedOrder(tx,id,user);
      await editable(tx,current);
      validateOrderSnapshot(current);
      if (current.items.length===data.length && data.every(item=>current.items.some(line=>line.productId===item.productId && line.quantity===item.quantity))) return current;
      const {items,...amounts}=calculateOrder(await newLines(tx,data,current.items),current);
      return tx.order.update({where:{id},data:{...amounts,items:{deleteMany:{},create:items}},include});
    });
    return res.json({message:'Order updated successfully',order:serializeOrder(order)});
  } catch(error) { return handleOrderError(res,error); }
};
export const cancelOrder = async(req,res)=>{
  const id=parseCatalogId(req.params.id);
  if (!id) return res.status(400).json({message:'Invalid order ID'});
  try {
    const order=await withActor(req,async(tx,user)=>{
      const current=await lockedOrder(tx,id,user);
      if (current.paymentHoldReason) throw orderError('Order requires payment reconciliation',409);
      if (current.status==='CANCELLED') return serializeOrder(current);
      await editable(tx,current);
      return serializeOrder(await tx.order.update({where:{id},data:{status:'CANCELLED'},include}));
    });
    return res.json({message:'Order cancelled successfully',order});
  } catch(error) { return handleOrderError(res,error); }
};
