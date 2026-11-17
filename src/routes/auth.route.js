import express from 'express';
import { login, refresh, logout, getMe, changePassword, updateProfile } from '../controllers/auth.controller.js';
import { authenticate, loginLimiter, passwordChangeLimiter, sameOrigin, requireJson, requirePasswordChangeComplete } from '../middlewares/auth.middleware.js';

const router = express.Router();
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.post('/login', sameOrigin, requireJson, loginLimiter, login);
router.post('/refresh', sameOrigin, refresh);
router.post('/logout', sameOrigin, logout);
router.get('/me', authenticate, getMe);
router.put('/profile', authenticate, requirePasswordChangeComplete, requireJson, updateProfile);
router.put('/password', authenticate, requireJson, passwordChangeLimiter, changePassword);
export default router;
