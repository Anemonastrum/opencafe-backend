import { prisma } from '../configs/prisma.js';
import { authConfig, safeUser, verifyAccessToken } from '../utils/auth.utils.js';
import { validSession } from '../utils/session.utils.js';

export const authenticate = async (req, res, next) => {
  const match = /^Bearer ([^ ]+)$/.exec(req.headers.authorization || '');
  let claims;
  try { claims = match && verifyAccessToken(match[1]); }
  catch { return res.status(401).json({ message: 'Invalid or expired access token' }); }
  if (!claims) return res.status(401).json({ message: 'Authentication required' });

  try {
    const session = await prisma.authSession.findUnique({ where: { id: claims.sid }, include: { user: true } });
    if (!validSession(session, session?.user) || session.userId !== Number(claims.sub)) return res.status(401).json({ message: 'Session expired or revoked' });
    req.user = safeUser(session.user);
    req.authSession = session.id;
    return next();
  } catch {
    return res.status(500).json({ message: 'Server error' });
  }
};

export const requireRoles = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) return res.status(403).json({ message: 'Permission denied' });
  return next();
};
export const requirePasswordChangeComplete = (req, res, next) => {
  if (req.user.mustChangePassword) return res.status(403).json({ message: 'Change your password before continuing', code: 'PASSWORD_CHANGE_REQUIRED' });
  return next();
};
export const sameOrigin = (req, res, next) => {
  const origin = req.headers.origin;
  if (req.headers['sec-fetch-site'] === 'cross-site' || (origin && (!authConfig.origin || origin !== authConfig.origin))) return res.status(403).json({ message: 'Cross-origin authentication request denied' });
  return next();
};

// ponytail: per-process limits; use shared store before deploying multiple instances.
export const createLoginLimiter = (now = Date.now) => {
  const attempts = new Map();
  return (req, res, next) => {
    const time = now();
    for (const [key, value] of attempts) if (value.until <= time) attempts.delete(key);
    const username = typeof req.body?.username === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(req.body.username) ? req.body.username.toLowerCase() : '<invalid>';
    const account = req.user ? `id:${req.user.id}` : `username:${username}`;
    const keys = [[`ip:${req.ip}`, 20], [`user:${account}`, 10]];
    if (keys.some(([key, limit]) => (attempts.get(key)?.count || 0) >= limit) || attempts.size + keys.filter(([key]) => !attempts.has(key)).length > 10000) return res.status(429).json({ message: 'Too many authentication attempts; try later' });
    for (const [key] of keys) {
      const entry = attempts.get(key) || { count: 0, until: time + 15 * 60000 };
      entry.count++;
      attempts.set(key, entry);
    }
    return next();
  };
};
export const loginLimiter = createLoginLimiter();
export const passwordChangeLimiter = createLoginLimiter();
export const requireJson = (req, res, next) => {
  if (!req.is('application/json')) return res.status(400).json({ message: 'Content-Type application/json required' });
  return next();
};
