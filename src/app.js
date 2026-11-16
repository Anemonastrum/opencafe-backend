import express from 'express';
import cafeSettingRoutes from './routes/cafeSetting.js';

const app = express();

app.use(express.json({ limit: '80kb' }));
app.use('/api/cafe-settings', cafeSettingRoutes);

// jangan kirim detail error internal ke client
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') return res.status(400).json({ message: 'JSON tidak valid atau terlalu besar' });
  res.status(500).json({ message: 'server error' });
});

export { app };
