import express from 'express';
import {
  createCafeSetting,
  getCafeSetting,
  updateCafeSetting,
  deleteCafeSetting,
} from '../controllers/cafe.controller.js';

import { authenticate, requirePasswordChangeComplete, requireRoles } from '../middlewares/auth.middleware.js';

const router = express.Router();
router.use(authenticate, requirePasswordChangeComplete);

router.get('/', getCafeSetting);
router.post('/', requireRoles('ADMIN'), createCafeSetting);
router.put('/', requireRoles('ADMIN'), updateCafeSetting);
router.delete('/', requireRoles('ADMIN'), deleteCafeSetting);

export default router;
