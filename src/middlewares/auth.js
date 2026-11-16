import { verifyAccess } from '../utils/auth.js';
import { fail } from '../utils/errors.js';

export const authenticate = ({ prisma, config }) => async (req, res, next) => {
  const header = req.get('Authorization');
  if (typeof header !== 'string' || !/^Bearer [^\s]+$/.test(header)) throw fail(401, 'UNAUTHORIZED');
  const payload = verifyAccess(header.slice(7), config);
  const session = await prisma.authSession.findUnique({ where: { id: payload.sid }, include: { user: true } });
  if (!session || session.userId !== Number(payload.sub) || session.revokedAt || session.expiresAt <= new Date() || !session.user.isActive) throw fail(401, 'UNAUTHORIZED');
  req.user = session.user;
  req.sessionId = session.id;
  next();
};
export const authorize = (...roles) => (req, res, next) => next(roles.includes(req.user?.role) ? undefined : fail(403, 'FORBIDDEN'));
