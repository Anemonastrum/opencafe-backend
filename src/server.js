import 'dotenv/config';
import { createPrisma } from './configs/prisma.js';
import { loadConfig } from './utils/config.js';
import { createApp } from './app.js';

let prisma;
try {
  const config = loadConfig();
  prisma = createPrisma();
  await prisma.$connect();
  const server = createApp({ prisma, config }).listen(config.port, () => {
    console.log(`Listening on port ${server.address().port}`);
  });
  server.on('error', async () => { console.error('Server failed to listen'); await prisma.$disconnect(); process.exitCode = 1; });
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 10000).unref();
    server.close(async () => { await prisma.$disconnect(); clearTimeout(deadline); });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
} catch {
  console.error('Startup failed: check configuration and database connectivity');
  await prisma?.$disconnect();
  process.exitCode = 1;
}
