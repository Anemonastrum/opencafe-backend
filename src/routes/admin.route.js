import express from 'express';
import { registerUser, listCashiers, getCashier, updateCashier, resetCashierPassword } from '../controllers/admin.controller.js';
import { authenticate, requireRoles, requirePasswordChangeComplete, requireJson, createLoginLimiter } from '../middlewares/auth.middleware.js';

import { uploadImage } from '../middlewares/upload.middleware.js';

import { getSalesReport, listSalesTransactions, exportSalesReport } from '../controllers/sales-report.controller.js';

const router = express.Router();
router.use('/reports/sales', (req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); next(); });
router.use(authenticate, requirePasswordChangeComplete, requireRoles('ADMIN'));
router.get('/reports/sales', getSalesReport);
router.get('/reports/sales/transactions', listSalesTransactions);
router.get('/reports/sales/export', exportSalesReport);
router.post('/users', uploadImage('image', registerUser));
router.get('/cashiers', listCashiers);
router.get('/cashiers/:id', getCashier);
router.put('/cashiers/:id', uploadImage('image', updateCashier));
router.put('/cashiers/:id/password', requireJson, createLoginLimiter(), resetCashierPassword);
export default router;
