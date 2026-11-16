import { fail } from '../utils/errors.js';

export const csrf = config => (req, res, next) => {
  const origin = req.get('Origin');
  if (req.get('X-Requested-With') !== 'XMLHttpRequest' || (origin !== undefined && origin !== config.appOrigin)) return next(fail(403, 'CSRF_REJECTED'));
  next();
};

export function loginLimiter({ clock = Date.now, maxKeys = 10000 } = {}) {
  const entries = new Map();
  // ponytail: one process only; use shared limiter store before running multiple instances.
  return (req, res, next) => {
    const now = clock();
    for (const [key, entry] of entries) if (entry.until <= now) entries.delete(key);
    const username = typeof req.body?.username === 'string' ? req.body.username.toLowerCase().slice(0, 100) : '';
    const keys = [['ip:' + req.ip, 50], ['user:' + username, 10]];
    if (entries.size + keys.filter(([key]) => !entries.has(key)).length > maxKeys || keys.some(([key, max]) => (entries.get(key)?.count || 0) >= max)) {
      res.set('Retry-After', '900');
      return next(fail(429, 'TOO_MANY_ATTEMPTS'));
    }
    for (const [key] of keys) {
      const entry = entries.get(key) || { count: 0, until: now + 900000 };
      entry.count++; entries.set(key, entry);
    }
    next();
  };
}
export function refreshCookie(req) {
  const values = (req.headers.cookie || '').split(';').map(value => value.trim()).filter(value => value.split('=')[0] === 'opencafe_refresh');
  if (values.length !== 1) return null;
  const value = values[0].slice('opencafe_refresh='.length);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
export const cookieOptions = config => ({ httpOnly: true, secure: config.production, sameSite: 'strict', path: '/api/auth' });
