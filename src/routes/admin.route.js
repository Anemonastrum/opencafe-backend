import express from 'express';
import { registerUser, listCashiers, getCashier, updateCashier, resetCashierPassword } from '../controllers/admin.controller.js';
import { authenticate, requireRoles, requirePasswordChangeComplete, requireJson, createLoginLimiter } from '../middlewares/auth.middleware.js';

const router = express.Router();
router.use(authenticate, requirePasswordChangeComplete, requireRoles('ADMIN'));
router.post('/users', requireJson, registerUser);
router.get('/cashiers', listCashiers);
router.get('/cashiers/:id', getCashier);
router.put('/cashiers/:id', requireJson, updateCashier);
router.put('/cashiers/:id/password', requireJson, createLoginLimiter(), resetCashierPassword);
export default router;
