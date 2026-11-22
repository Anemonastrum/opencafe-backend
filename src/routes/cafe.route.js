import express from 'express';
import {
  createCafeSetting,
  getCafeSetting,
  getCafeBranding,
  updateCafeSetting,
  deleteCafeSetting,
} from '../controllers/cafe.controller.js';

import { authenticate, requirePasswordChangeComplete, requireRoles } from '../middlewares/auth.middleware.js';

import { uploadImage } from '../middlewares/upload.middleware.js';

const router = express.Router();
router.get('/branding', getCafeBranding);
router.use(authenticate, requirePasswordChangeComplete);

router.get('/', getCafeSetting);
router.post('/', requireRoles('ADMIN'), uploadImage('logo', createCafeSetting));
router.put('/', requireRoles('ADMIN'), uploadImage('logo', updateCafeSetting));
router.delete('/', requireRoles('ADMIN'), deleteCafeSetting);

export default router;
