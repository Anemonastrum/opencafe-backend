import express from 'express';
import { authRoutes } from './routes/auth.routes.js';
import { errorHandler } from './middlewares/errors.js';
import { fail } from './utils/errors.js';

export function createApp(dependencies) {
  const app = express();
  app.disable('x-powered-by');
  app.use('/api/auth', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use(express.json({ limit: '8kb' }));
  app.use('/api/auth', authRoutes(dependencies));
  app.use((req, res, next) => next(fail(404, 'NOT_FOUND')));
  app.use(errorHandler);
  return app;
}
