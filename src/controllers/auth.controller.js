import { prisma } from '../configs/prisma.js';
import { saveImage, removeImage } from '../utils/image.utils.js';
import { validateProfile } from '../utils/user.utils.js';
import { authConfig, createAccessToken, hashPassword, safeUser, validateLogin, validatePasswordChange, verifyPassword } from '../utils/auth.utils.js';
import { clearRefreshCookie, newSession, readRefreshCookie, revokeSession, rotateSession, setRefreshCookie, validSession, withUserLock } from '../utils/session.utils.js';

const handleError = (res, error) => res.status(error.status === 429 ? 429 : 500).json({ message: error.status === 429 ? 'Too many authentication requests' : 'Server error' });
const invalidLogin = res => res.status(401).json({ message: 'Invalid username or password' });
const sendSession = (res, result) => {
  setRefreshCookie(res, result.token, result.session);
  return res.json({ message: 'Login successful', accessToken: createAccessToken(result.user.id, result.session.id), expiresIn: authConfig.accessSeconds, user: safeUser(result.user) });
};

// LOGIN
export const login = async (req, res) => {
  const { data, error } = validateLogin(req.body);
  if (error) return res.status(400).json({ message: error });
  try {
    const user = await prisma.user.findUnique({ where: { username: data.username } });
    // Missing accounts still pay same hash cost; never disclose account existence.
    const dummy = `scrypt$16384$8$1$${'0'.repeat(32)}$${'0'.repeat(128)}`;
    const verified = await verifyPassword(data.password, user?.passwordHash || dummy);
    if (!verified || !user?.isActive) return invalidLogin(res);
    const result = await withUserLock(user.id, async (tx, current) => {
      if (!current?.isActive || current.passwordHash !== user.passwordHash) return null;
      return { ...await newSession(tx, user.id), user: current };
    });
    if (!result) return invalidLogin(res);
    return sendSession(res, result);
  } catch (error) { return handleError(res, error); }
};

// REFRESH
export const refresh = async (req, res) => {
  const token = readRefreshCookie(req);
  if (!token) return res.status(401).json({ message: 'Refresh cookie required' });
  try {
    const result = await rotateSession(token);
    if (!result) {
      clearRefreshCookie(res);
      return res.status(401).json({ message: 'Refresh session expired or revoked' });
    }
    return sendSession(res, result);
  } catch (error) { return handleError(res, error); }
};

// LOGOUT
export const logout = async (req, res) => {
  try {
    const token = readRefreshCookie(req);
    if (token) await revokeSession(token);
    clearRefreshCookie(res);
    return res.json({ message: 'Logged out successfully' });
  } catch (error) { return handleError(res, error); }
};

export const getMe = (req, res) => res.json({ user: req.user });

// UPDATE OWN PROFILE
export const updateProfile = async (req, res) => {
  const { data, error } = validateProfile(req.body);
  if (error) return res.status(400).json({ message: error });
  let saved, previous;
  try {
    const user = await withUserLock(req.user.id, async (tx, current) => {
      const session = await tx.authSession.findUnique({ where: { id: req.authSession } });
      if (!validSession(session, current)) return null;
      previous = current.imageUrl;
      if (req.image) { saved = await saveImage(req.image, `user/${current.id}`); data.imageUrl = saved.url; }
      return tx.user.update({ where: { id: current.id }, data });
    });
    if (!user) return res.status(401).json({ message: 'Session or account changed; sign in again' });
    if (Object.hasOwn(data, 'imageUrl')) await removeImage(previous);
    return res.json({ message: 'Profile updated successfully', user: safeUser(user) });
  } catch (error) {
    if (saved) await removeImage(saved.url);
    if (error.code === 'P2002') return res.status(409).json({ message: 'Username already exists' });
    return handleError(res, error);
  }
};

// CHANGE OWN PASSWORD
export const changePassword = async (req, res) => {
  const { data, error } = validatePasswordChange(req.body);
  if (error) return res.status(400).json({ message: error });
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user || !await verifyPassword(data.currentPassword, user.passwordHash)) return invalidLogin(res);
    const passwordHash = await hashPassword(data.newPassword);
    const changed = await withUserLock(user.id, async (tx, current) => {
      const session = await tx.authSession.findUnique({ where: { id: req.authSession } });
      if (!validSession(session, current) || current.passwordHash !== user.passwordHash) return false;
      await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
      await tx.authSession.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
      return true;
    });
    if (!changed) return res.status(401).json({ message: 'Session or password changed; sign in again' });
    clearRefreshCookie(res);
    return res.json({ message: 'Password changed successfully; sign in again' });
  } catch (error) { return handleError(res, error); }
};
