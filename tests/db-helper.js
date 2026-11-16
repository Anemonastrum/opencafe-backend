import 'dotenv/config';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '../src/generated/prisma/client.ts';

export function testDatabase() {
  let url;
  try {
    url = new URL(process.env.TEST_DATABASE_URL);
    if (url.protocol !== 'mysql:' || url.search || url.hash || `${url.hostname}:${url.port || 3306}${url.pathname}` !== process.env.TEST_DATABASE_ACK) throw new Error();
  } catch { throw new Error('Set TEST_DATABASE_URL and exact TEST_DATABASE_ACK=host:port/schema for authorized fixture writes'); }
  return new PrismaClient({ adapter: new PrismaMariaDb({ host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: url.pathname.slice(1), timezone: 'Z', connectionLimit: 5, connectTimeout: 5000 }) });
}
export function barrier() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
