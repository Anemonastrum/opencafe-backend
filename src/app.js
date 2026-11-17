import express from 'express';
import { isUtf8 } from 'node:buffer';
import authRoutes from './routes/auth.route.js';
import adminRoutes from './routes/admin.route.js';
import cafeSettingRoutes from './routes/cafe.route.js';
import productRoutes from './routes/product.route.js';
import categoryRoutes from './routes/category.route.js';

const app = express();

// Preserve money tokens before Number rounding; other JSON fields keep normal types.
app.use(express.json({ limit: '80kb', reviver: (key, value, context) => key === 'price' && typeof value === 'number' ? context.source : value, verify: (req, res, buffer) => {
  if (!isUtf8(buffer)) throw Object.assign(new Error('Invalid UTF-8'), { status: 400 });
} }));
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/cafe', cafeSettingRoutes);
app.use('/api/products', productRoutes);
app.use('/api/categories', categoryRoutes);

// stop send error to client if json is too large or invalid
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large' || err.type === 'entity.verify.failed') return res.status(400).json({ message: 'JSON is too large' });
  res.status(500).json({ message: 'server error' });
});

export { app };
