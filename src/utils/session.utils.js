import { randomUUID } from 'node:crypto';
import { prisma } from '../configs/prisma.js';
import { authConfig, createRefreshToken, refreshDigest } from './auth.utils.js';

// All auth writers lock user first, then session. Hash work stays outside locks.
export const withUserLock = (userId, callback) => prisma.$transaction(async tx => {
  await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
  const user = await tx.user.findUnique({ where: { id: userId } });
  return callback(tx, user);
}, { isolationLevel: 'ReadCommitted' });

export const newSession = async (tx, userId) => {
  const token = createRefreshToken();
  const session = await tx.authSession.create({ data: { id: randomUUID(), userId, expiresAt: new Date(Date.now() + authConfig.sessionMs) } });
  await tx.refreshToken.create({ data: { digest: refreshDigest(token), sessionId: session.id } });
  return { session, token };
};

export const validSession = (session, user) => user?.isActive && session && session.userId === user.id && !session.revokedAt && session.expiresAt > new Date();

// Replay returns a failed outcome, not a throw, so revocation commits.
export const rotateSession = async token => {
  const digest = refreshDigest(token);
  const found = await prisma.refreshToken.findUnique({ where: { digest }, include: { session: true } });
  if (!found) return null;
  return withUserLock(found.session.userId, async (tx, user) => {
    await tx.$queryRaw`SELECT id FROM auth_sessions WHERE id = ${found.sessionId} FOR UPDATE`;
    const session = await tx.authSession.findUnique({ where: { id: found.sessionId } });
    const stored = await tx.refreshToken.findUnique({ where: { digest } });
    if (!validSession(session, user) || !stored) return null;
    if (stored.consumedAt) {
      await tx.authSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
      return null;
    }
    const replacement = createRefreshToken();
    await tx.refreshToken.update({ where: { digest }, data: { consumedAt: new Date() } });
    await tx.refreshToken.create({ data: { digest: refreshDigest(replacement), sessionId: session.id } });
    return { user, session, token: replacement };
  });
};

export const revokeSession = async token => {
  const found = await prisma.refreshToken.findUnique({ where: { digest: refreshDigest(token) }, include: { session: true } });
  if (!found) return;
  await withUserLock(found.session.userId, async tx => {
    await tx.$queryRaw`SELECT id FROM auth_sessions WHERE id = ${found.sessionId} FOR UPDATE`;
    await tx.authSession.updateMany({ where: { id: found.sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
  });
};

const cookieOptions = { httpOnly: true, secure: authConfig.production, sameSite: 'strict', path: '/api/auth' };
export const setRefreshCookie = (res, token, session) => res.cookie('opencafe_refresh', token, { ...cookieOptions, maxAge: Math.max(0, session.expiresAt.getTime() - Date.now()) });
export const clearRefreshCookie = res => res.clearCookie('opencafe_refresh', cookieOptions);
export const readRefreshCookie = req => {
  const values = (req.headers.cookie || '').split(';').map(part => part.trim()).filter(part => part.startsWith('opencafe_refresh='));
  if (values.length !== 1) return null;
  const value = values[0].slice('opencafe_refresh='.length);
  return /^[a-f0-9]{64}$/.test(value) ? value : null;
};
