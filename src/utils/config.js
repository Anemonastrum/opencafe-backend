export function loadConfig(env = process.env) {
  const jwtSecret = env.JWT_SECRET;
  if (typeof jwtSecret !== 'string' || Buffer.byteLength(jwtSecret) < 32 || /\s|[\x00-\x1f\x7f]/u.test(jwtSecret)) throw new Error('JWT_SECRET must contain at least 32 bytes without whitespace or controls');
  let origin;
  try { origin = new URL(env.APP_ORIGIN); } catch { throw new Error('APP_ORIGIN must be an exact HTTP(S) origin'); }
  const production = env.NODE_ENV === 'production';
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== env.APP_ORIGIN || origin.username || origin.password || (production && origin.protocol !== 'https:')) throw new Error('APP_ORIGIN must be an exact HTTP(S) origin; production requires HTTPS');
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORT');
  return { jwtSecret, appOrigin: origin.origin, production, port, issuer: 'opencafe', audience: 'opencafe-api', accessSeconds: 900, refreshSeconds: 30 * 86400 };
}
