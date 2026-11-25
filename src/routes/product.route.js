import express from 'express';
import { listProducts, getProduct, createProduct, updateProduct, deleteProduct } from '../controllers/product.controller.js';
import { authenticate, requireRoles, requireJson } from '../middlewares/auth.middleware.js';
import { uploadImage } from '../middlewares/upload.middleware.js';

const router=express.Router();
router.use(authenticate);
router.get('/',listProducts);
router.get('/:id',getProduct);
router.post('/',requireRoles('ADMIN'),uploadImage('image',createProduct));
router.put('/:id',requireRoles('ADMIN'),uploadImage('image',updateProduct));
router.delete('/:id',requireRoles('ADMIN'),deleteProduct);
export default router;
