import 'dotenv/config';
import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import jwt from 'jsonwebtoken';
import { passwordValid, validateProfile } from './user.utils.js';
export { safeUser } from './user.utils.js';

const secret = process.env.JWT_SECRET;
if (!secret || Buffer.byteLength(secret) < 32 || secret !== secret.trim() || /[\x00-\x20\x7f]/.test(secret)) throw new Error('JWT_SECRET must contain at least 32 bytes without whitespace or controls');
const production = process.env.NODE_ENV === 'production';
let origin;
if (process.env.APP_ORIGIN) {
  const url = new URL(process.env.APP_ORIGIN);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== process.env.APP_ORIGIN || url.username || url.password || (production && url.protocol !== 'https:')) throw new Error('APP_ORIGIN must be an exact HTTP(S) origin; HTTPS required in production');
  origin = url.origin;
}
if (production && !origin) throw new Error('APP_ORIGIN required in production');
export const authConfig = { production, origin, accessSeconds: 900, sessionMs: 30 * 86400000 };
const derive = promisify(scrypt);
let hashJobs = 0;

const keyFor = async (password, salt) => {
  if (hashJobs >= 4) throw Object.assign(new Error('Too many authentication requests'), { status: 429 });
  hashJobs++;
  try { return await derive(password, salt, 64, { N: 16384, r: 8, p: 1 }); }
  finally { hashJobs--; }
};
export const hashPassword = async password => {
  if (!passwordValid(password)) throw Object.assign(new Error('Password must contain 8–128 UTF-8 bytes'), { status: 400 });
  const salt = randomBytes(16).toString('hex');
  const key = await keyFor(password, salt);
  return `scrypt$16384$8$1$${salt}$${key.toString('hex')}`;
};
export const verifyPassword = async (password, hash) => {
  if (!passwordValid(password) || typeof hash !== 'string' || !/^scrypt\$16384\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(hash)) return false;
  const parts = hash.split('$');
  const key = await keyFor(password, parts[4]);
  return timingSafeEqual(key, Buffer.from(parts[5], 'hex'));
};
const objectWith = (body, keys) => body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).every(key => keys.includes(key));
const usernameValid = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(value);
export const validateLogin = body => {
  if (!objectWith(body, ['username', 'password']) || !usernameValid(body.username) || !passwordValid(body.password)) return { error: 'Valid username and password (8–128 UTF-8 bytes) required' };
  return { data: { username: body.username.toLowerCase(), password: body.password } };
};
export const validateRegistration = body => {
  if (!objectWith(body, ['name', 'username', 'password', 'role', 'imageUrl']) || typeof body.name !== 'string' || !body.name.isWellFormed() || !body.name.trim() || [...body.name.trim()].length > 100 || !usernameValid(body.username) || !passwordValid(body.password) || (body.role !== undefined && !['ADMIN', 'CASHIER'].includes(body.role))) return { error: 'Valid name, username, password and ADMIN/CASHIER role required' };
  const image = body.imageUrl === undefined ? {} : validateProfile({ imageUrl: body.imageUrl });
  if (image.error) return image;
  return { data: { name: body.name.trim(), username: body.username.toLowerCase(), password: body.password, role: body.role || 'CASHIER', ...image.data } };
};
export const validatePasswordChange = body => {
  if (!objectWith(body, ['currentPassword', 'newPassword']) || !passwordValid(body.currentPassword) || !passwordValid(body.newPassword) || body.currentPassword === body.newPassword) return { error: 'Current password and different new password (8–128 UTF-8 bytes) required' };
  return { data: { currentPassword: body.currentPassword, newPassword: body.newPassword } };
};
export const createAccessToken = (userId, sessionId) => jwt.sign({ sid: sessionId }, secret, { algorithm: 'HS256', subject: String(userId), expiresIn: authConfig.accessSeconds, issuer: 'opencafe', audience: 'opencafe-api' });
export const verifyAccessToken = token => {
  const claims = jwt.verify(token, secret, { algorithms: ['HS256'], issuer: 'opencafe', audience: 'opencafe-api' });
  if (typeof claims !== 'object' || !/^[1-9]\d*$/.test(claims.sub) || !Number.isSafeInteger(Number(claims.sub)) || typeof claims.sid !== 'string' || !claims.sid || !Number.isInteger(claims.exp)) throw new Error('Invalid access token');
  return claims;
};
export const createRefreshToken = () => randomBytes(32).toString('hex');
export const refreshDigest = token => createHash('sha256').update(token).digest('hex');
