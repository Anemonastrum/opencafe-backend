import { hashPassword, verifyPassword, dummyHash, signAccess } from '../utils/auth.js';
import { parseRegister, parseLogin, safeUser } from '../utils/validation.js';
import { createSession, rotateSession, revokeSession } from '../utils/sessions.js';
import { fail } from '../utils/errors.js';
import { cookieOptions, refreshCookie } from '../middlewares/security.js';

export function authController({ prisma, config }) {
  const clear = res => res.clearCookie('opencafe_refresh', cookieOptions(config));
  function tokens(res, user, session, refreshToken) {
    const accessToken = signAccess(user.id, session.id, config);
    res.cookie('opencafe_refresh', refreshToken, { ...cookieOptions(config), expires: session.expiresAt });
    res.json({ accessToken, expiresIn: config.accessSeconds, user: safeUser(user) });
  }
  return {
    register: async (req, res) => {
      const { password, ...data } = parseRegister(req.body);
      const passwordHash = await hashPassword(password);
      const user = await prisma.user.create({ data: { ...data, passwordHash } });
      res.status(201).json({ user: safeUser(user) });
    },
    login: async (req, res) => {
      const { username, password } = parseLogin(req.body);
      const user = await prisma.user.findUnique({ where: { username } });
      const valid = await verifyPassword(password, user?.passwordHash || dummyHash);
      if (!valid || !user?.isActive) throw fail(401, 'INVALID_CREDENTIALS');
      const { session, refreshToken } = await createSession(prisma, user.id);
      tokens(res, user, session, refreshToken);
    },
    refresh: async (req, res) => {
      const result = await rotateSession(prisma, refreshCookie(req));
      if (!result) { clear(res); throw fail(401, 'UNAUTHORIZED'); }
      tokens(res, result.user, result.session, result.refreshToken);
    },
    logout: async (req, res) => {
      await revokeSession(prisma, refreshCookie(req));
      clear(res); res.sendStatus(204);
    },
    me: (req, res) => res.json({ user: safeUser(req.user) }),
  };
}
