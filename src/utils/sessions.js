import { randomUUID } from 'node:crypto';
import { digestToken, newRefreshToken, hashPassword } from './auth.js';
import { safeUser, parseRegister } from './validation.js';
import { fail } from './errors.js';

const transactionOptions = { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 10000 };
export async function createSession(db, userId, now = new Date()) {
  const refreshToken = newRefreshToken();
  const session = await db.$transaction(async tx => {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user?.isActive) throw fail(401, 'UNAUTHORIZED');
    return tx.authSession.create({ data: { id: randomUUID(), userId, expiresAt: new Date(now.getTime() + 30 * 86400000), tokens: { create: { digest: digestToken(refreshToken) } } } });
  }, transactionOptions);
  return { session, refreshToken };
}

async function lockedToken(tx, rawToken) {
  if (typeof rawToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(rawToken)) return null;
  const digest = digestToken(rawToken);
  const found = await tx.refreshToken.findUnique({ where: { digest } });
  if (!found) return null;
  await tx.$queryRaw`SELECT id FROM auth_sessions WHERE id = ${found.sessionId} FOR UPDATE`;
  return tx.refreshToken.findUnique({ where: { digest }, include: { session: { include: { user: true } } } });
}

export async function rotateSession(db, rawToken, now = new Date()) {
  const refreshToken = newRefreshToken();
  return db.$transaction(async tx => {
    const token = await lockedToken(tx, rawToken);
    if (!token) return null;
    const { session } = token;
    if (session.revokedAt || session.expiresAt <= now) return null;
    if (token.consumedAt || !session.user.isActive) {
      await tx.authSession.update({ where: { id: session.id }, data: { revokedAt: now } });
      return null; // Commit revocation before HTTP layer raises 401.
    }
    await tx.refreshToken.update({ where: { digest: token.digest }, data: { consumedAt: now } });
    await tx.refreshToken.create({ data: { digest: digestToken(refreshToken), sessionId: session.id } });
    return { session, user: session.user, refreshToken };
  }, transactionOptions);
}

export async function revokeSession(db, rawToken, now = new Date()) {
  await db.$transaction(async tx => {
    const token = await lockedToken(tx, rawToken);
    if (token && !token.session.revokedAt) await tx.authSession.update({ where: { id: token.sessionId }, data: { revokedAt: now } });
  }, transactionOptions);
}

export async function createFirstAdmin(db, input) {
  const { password, ...data } = parseRegister({ ...input, role: 'ADMIN' });
  const passwordHash = await hashPassword(password);
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.$transaction(async tx => {
        if (await tx.user.count({ where: { role: 'ADMIN' } })) throw fail(409, 'ADMIN_ALREADY_EXISTS');
        return safeUser(await tx.user.create({ data: { ...data, passwordHash } }));
      }, { ...transactionOptions, isolationLevel: 'Serializable' });
    } catch (error) {
      if (error.code !== 'P2034' || attempt >= 2) throw error;
    }
  }
}
