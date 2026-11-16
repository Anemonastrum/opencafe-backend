import 'dotenv/config';
import { app } from './app.js';
import { prisma } from './configs/prisma.js';

const PORT = process.env.PORT;
const HOST = process.env.HOST;

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