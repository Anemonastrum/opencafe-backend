import 'dotenv/config';
import { app } from './app.js';
import { imageApp } from './image.app.js';
import { imageConfig } from './utils/image.utils.js';
import { prisma } from './configs/prisma.js';
import { startNotificationScheduler } from './utils/notification-scheduler.utils.js';

const port = value => {
  if (!/^[1-9]\d{0,4}$/.test(String(value)) || Number(value) > 65535) throw new Error('Server ports must be integers from 1 to 65535');
  return Number(value);
};
const servers = [];
let stopping = false;
let notificationScheduler;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  await notificationScheduler?.stop();
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  await prisma.$disconnect();
};
const listen = (application, number, host) => new Promise((resolve, reject) => {
  if (stopping) return reject(new Error('Server stopping'));
  const server = application.listen(number, host, error => {
    if (error) return reject(error);
    if (stopping) return server.close(() => reject(new Error('Server stopping')));
    resolve(server);
  });
  servers.push(server);
  server.once('error', reject);
});
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
try {
  const apiPort = port(process.env.PORT);
  const imagePort = port(imageConfig.port);
  if (apiPort === imagePort) throw new Error('API and image server ports must differ');
  await listen(app, apiPort, process.env.HOST);
  await listen(imageApp, imagePort, imageConfig.host);
  if (stopping) throw new Error('Server stopping');
  notificationScheduler = startNotificationScheduler(prisma);
  for (const server of servers) server.on('error', () => { process.exitCode = 1; shutdown(); });
  console.log(`API listening on http://${process.env.HOST}:${apiPort}`);
  console.log(`Image server listening on http://${imageConfig.host}:${imagePort}`);
} catch (error) {
  console.error('Server startup failed:', error.code || 'unknown');
  process.exitCode = 1;
  await shutdown();
}
