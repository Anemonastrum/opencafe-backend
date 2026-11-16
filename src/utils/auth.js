import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import jwt from 'jsonwebtoken';
import { fail } from './errors.js';

const derive = promisify(scrypt);
let active = 0;
async function passwordKey(password, salt) {
  if (active >= 4) throw fail(429, 'AUTH_BUSY');
  active++;
  try { return await derive(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }); }
  finally { active--; }
}
export async function hashPassword(password) {
  if (typeof password !== 'string' || !password.isWellFormed()) throw fail(400, 'INVALID_INPUT');
  const salt = randomBytes(16).toString('hex');
  return `scrypt$v1$${salt}$${(await passwordKey(password, salt)).toString('hex')}`;
}
export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || !password.isWellFormed()) return false;
  if (typeof stored !== 'string' || !/^scrypt\$v1\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(stored)) return false;
  const [, , salt, hex] = stored.split('$');
  return timingSafeEqual(await passwordKey(password, salt), Buffer.from(hex, 'hex'));
}
export const dummyHash = 'scrypt$v1$' + '0'.repeat(32) + '$' + '0'.repeat(128);
export function signAccess(userId, sessionId, config) {
  return jwt.sign({ sid: sessionId }, config.jwtSecret, { algorithm: 'HS256', subject: String(userId), issuer: config.issuer, audience: config.audience, expiresIn: config.accessSeconds });
}
export function verifyAccess(token, config) {
  let payload;
  try { payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'], issuer: config.issuer, audience: config.audience }); } catch { throw fail(401, 'UNAUTHORIZED'); }
  if (!payload || !/^[1-9][0-9]*$/.test(payload.sub) || !Number.isSafeInteger(Number(payload.sub)) || !/^[a-f0-9-]{36}$/.test(payload.sid) || !Number.isInteger(payload.exp)) throw fail(401, 'UNAUTHORIZED');
  return payload;
}
export const newRefreshToken = () => randomBytes(32).toString('base64url');
export const digestToken = token => createHash('sha256').update(token).digest('hex');
