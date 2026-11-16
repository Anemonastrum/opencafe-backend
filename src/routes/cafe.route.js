import express from 'express';
import {
  createCafeSetting,
  getCafeSetting,
  updateCafeSetting,
  deleteCafeSetting,
} from '../controllers/cafe.controller.js';

const router = express.Router();

router.get('/', getCafeSetting);
router.post('/', createCafeSetting);
router.put('/', updateCafeSetting);
router.delete('/', deleteCafeSetting);

export default router;
