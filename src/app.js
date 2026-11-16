import express from 'express';
import cafeSettingRoutes from './routes/cafe.route.js';

const app = express();

app.use(express.json({ limit: '80kb' }));
app.use('/api/cafe', cafeSettingRoutes);

// stop send error to client if json is too large or invalid
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') return res.status(400).json({ message: 'JSON is too large' });
  res.status(500).json({ message: 'server error' });
});

export { app };
