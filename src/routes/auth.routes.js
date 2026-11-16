import { Router } from 'express';
import { authController } from '../controllers/auth.controller.js';
import { authenticate, authorize } from '../middlewares/auth.js';
import { csrf, loginLimiter } from '../middlewares/security.js';

export function authRoutes(dependencies) {
  const router = Router();
  const controller = authController(dependencies);
  const authenticated = authenticate(dependencies);
  const cookieGuard = csrf(dependencies.config);
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.post('/register', authenticated, authorize('ADMIN'), controller.register);
  router.post('/login', cookieGuard, loginLimiter(), controller.login);
  router.post('/refresh', cookieGuard, controller.refresh);
  router.post('/logout', cookieGuard, controller.logout);
  router.get('/me', authenticated, authorize('ADMIN', 'CASHIER'), controller.me);
  return router;
}
