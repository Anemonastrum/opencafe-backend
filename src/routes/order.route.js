import express from 'express';
import { createOrder, listOrders, getOrder, updateOrder, cancelOrder } from '../controllers/order.controller.js';
import { createPayment, listPayments, reconcilePayment } from '../controllers/payment.controller.js';
import { authenticate, requirePasswordChangeComplete, requireRoles, requireJson } from '../middlewares/auth.middleware.js';

const router=express.Router();
router.use(authenticate,requirePasswordChangeComplete,requireRoles('ADMIN','CASHIER'));
router.use((req,res,next)=>{
  try {
    const query=req.originalUrl.split('?')[1]||'';
    for (const part of query.split('&')) for (const component of part.split('=')) decodeURIComponent(component.replaceAll('+',' '));
  } catch { return res.status(400).json({message:'Invalid query encoding'}); }
  return next();
});
router.get('/',listOrders);
router.get('/:id',getOrder);
router.get('/:id/payments',listPayments);
router.post('/:id/payments',requireJson,createPayment);
router.post('/:id/payments/:paymentId/reconcile',reconcilePayment);
router.post('/',requireJson,createOrder);
router.put('/:id',requireJson,updateOrder);
router.post('/:id/cancel',(req,res,next)=>{
  const hasBody=Number(req.headers['content-length'])>0 || req.headers['transfer-encoding'];
  if (hasBody && (!req.is('application/json') || !req.body || typeof req.body!=='object' || Array.isArray(req.body) || Object.keys(req.body).length)) return res.status(400).json({message:'Cancellation accepts no fields'});
  return next();
},cancelOrder);
export default router;
