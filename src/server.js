import 'dotenv/config';
import { app } from './app.js';
import { prisma } from './configs/prisma.js';

const PORT = Number(process.env.PORT || 3000);
// auth belum ada, pakai localhost dulu
const HOST = process.env.HOST || '127.0.0.1';

const server = app.listen(PORT, HOST, () => {
  console.log(`Starting Server on http://${HOST}:${server.address().port}`);
});

const shutdown = () => {
  server.close(async () => {
    await prisma.$disconnect();
  });
};

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);