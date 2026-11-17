import express from 'express';
import { registerUser } from '../controllers/admin.controller.js';
import { authenticate, requireRoles, requirePasswordChangeComplete, requireJson } from '../middlewares/auth.middleware.js';

const router = express.Router();
router.use(authenticate, requirePasswordChangeComplete, requireRoles('ADMIN'));
router.post('/users', requireJson, registerUser);
export default router;
