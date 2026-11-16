import 'dotenv/config';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '../generated/prisma/client.ts';

export function createPrisma(env = process.env) {
  let options;
  try {
    const url = new URL(env.DATABASE_URL);
    if (url.protocol !== 'mysql:' || url.search || url.hash || !/^\/[a-zA-Z0-9_]+$/.test(url.pathname)) throw new Error();
    options = { host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: url.pathname.slice(1) };
  } catch { throw new Error('DATABASE_URL must be a valid mysql:// URL without query options'); }
  return new PrismaClient({ adapter: new PrismaMariaDb({ ...options, connectionLimit: 10, connectTimeout: 5000, acquireTimeout: 5000, timezone: 'Z' }) });
}
