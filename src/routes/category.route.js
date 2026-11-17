import express from 'express';
import { listCategories, getCategory, createCategory, updateCategory, deleteCategory } from '../controllers/category.controller.js';
import { authenticate, requirePasswordChangeComplete, requireRoles, requireJson } from '../middlewares/auth.middleware.js';

const router=express.Router();
router.use(authenticate,requirePasswordChangeComplete);
router.get('/',listCategories);
router.get('/:id',getCategory);
router.post('/',requireRoles('ADMIN'),requireJson,createCategory);
router.put('/:id',requireRoles('ADMIN'),requireJson,updateCategory);
router.delete('/:id',requireRoles('ADMIN'),deleteCategory);
export default router;
