import { Router } from 'express';
import { authenticate, requireRoles } from '../middlewares/auth.middleware.js';
import { listNotifications, getUnreadNotificationCount, markNotificationRead, markAllNotificationsRead } from '../controllers/notification.controller.js';

const router = Router();
router.use((req, res, next) => { res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }); next(); });
router.use(authenticate, requireRoles('ADMIN', 'CASHIER'));
router.get('/', listNotifications);
router.get('/unread-count', getUnreadNotificationCount);
router.patch('/read-all', markAllNotificationsRead);
router.patch('/:id/read', markNotificationRead);
export default router;
