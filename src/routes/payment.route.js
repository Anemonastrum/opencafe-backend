import express from 'express';
import { midtransNotification } from '../controllers/payment.controller.js';
import { requireJson } from '../middlewares/auth.middleware.js';
const router = express.Router();
router.post('/midtrans/notification', requireJson, midtransNotification);
export default router;
