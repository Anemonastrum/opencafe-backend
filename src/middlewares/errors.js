export function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  if (error.code === 'P2002') return res.status(409).json({ error: { code: 'USERNAME_EXISTS' } });
  if (['entity.parse.failed', 'entity.too.large'].includes(error.type)) return res.status(400).json({ error: { code: 'INVALID_INPUT' } });
  const safe = Number.isInteger(error.status) && error.status >= 400 && error.status < 500 && /^[A-Z_]+$/.test(error.code);
  if (error.status === 429) res.set('Retry-After', '900');
  return res.status(safe ? error.status : 500).json({ error: { code: safe ? error.code : 'INTERNAL_ERROR' } });
}
