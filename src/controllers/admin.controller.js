import { prisma } from '../configs/prisma.js';
import { saveImage, removeImage } from '../utils/image.utils.js';
import { validateProfile, validateResetPassword, parseUserId, parseCashierPage, safeCashier } from '../utils/user.utils.js';
import { hashPassword, safeUser, validateRegistration } from '../utils/auth.utils.js';
import { validSession, withUserLock } from '../utils/session.utils.js';

const handleError = (res, error) => {
  const errors = { P2002: { status: 409, message: 'Username already exists' } };
  const response = errors[error.code];
  if (response) return res.status(response.status).json({ message: response.message });
  return res.status([400, 403, 404, 429].includes(error.status) ? error.status : 500).json({ message: error.status ? error.message : 'Server error' });
};

// Lock users in ID order, before sessions, matching all authentication writers.
const withCashierLock = (req, id, callback) => prisma.$transaction(async tx => {
  for (const userId of [...new Set([req.user.id, id])].sort((a, b) => a - b)) {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
  }
  const admin = await tx.user.findUnique({ where: { id: req.user.id } });
  const session = await tx.authSession.findUnique({ where: { id: req.authSession } });
  if (!validSession(session, admin) || admin.role !== 'ADMIN') throw Object.assign(new Error('Administrator permission required'), { status: 403 });
  const cashier = await tx.user.findUnique({ where: { id } });
  if (!cashier || cashier.role !== 'CASHIER') throw Object.assign(new Error('Cashier not found'), { status: 404 });
  return callback(tx, cashier);
}, { isolationLevel: 'ReadCommitted' });

export const listCashiers = async (req, res) => {
  const { data, error } = parseCashierPage(req.query);
  if (error) return res.status(400).json({ message: error });
  try {
    const where = { role: 'CASHIER' };
    const [cashiers, total] = await Promise.all([
      prisma.user.findMany({ where, orderBy: { id: 'asc' }, skip: (data.page - 1) * data.limit, take: data.limit }),
      prisma.user.count({ where }),
    ]);
    return res.json({ cashiers: cashiers.map(safeCashier), ...data, total });
  } catch (error) { return handleError(res, error); }
};

export const getCashier = async (req, res) => {
  const id = parseUserId(req.params.id);
  if (!id) return res.status(400).json({ message: 'Invalid cashier ID' });
  try {
    const cashier = await prisma.user.findFirst({ where: { id, role: 'CASHIER' } });
    if (!cashier) return res.status(404).json({ message: 'Cashier not found' });
    return res.json({ cashier: safeCashier(cashier) });
  } catch (error) { return handleError(res, error); }
};

export const updateCashier = async (req, res) => {
  const id = parseUserId(req.params.id);
  if (!id) return res.status(400).json({ message: 'Invalid cashier ID' });
  const { data, error } = validateProfile(req.body, true);
  if (error) return res.status(400).json({ message: error });
  let saved, previous;
  try {
    const cashier = await withCashierLock(req, id, async (tx, current) => {
      previous = current.imageUrl;
      if (req.image) { saved = await saveImage(req.image, `user/${current.id}`); data.imageUrl = saved.url; }
      const updated = await tx.user.update({ where: { id: current.id }, data });
      if (data.isActive === false) await tx.authSession.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      return updated;
    });
    if (Object.hasOwn(data, 'imageUrl')) await removeImage(previous);
    return res.json({ message: 'Cashier updated successfully', cashier: safeCashier(cashier) });
  } catch (error) { if (saved) await removeImage(saved.url); return handleError(res, error); }
};

export const resetCashierPassword = async (req, res) => {
  const id = parseUserId(req.params.id);
  if (!id) return res.status(400).json({ message: 'Invalid cashier ID' });
  const { data, error } = validateResetPassword(req.body);
  if (error) return res.status(400).json({ message: error });
  try {
    const passwordHash = await hashPassword(data.newPassword);
    await withCashierLock(req, id, async tx => {
      await tx.user.update({ where: { id }, data: { passwordHash } });
      await tx.authSession.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    });
    return res.json({ message: 'Cashier password reset successfully' });
  } catch (error) { return handleError(res, error); }
};

// REGISTER ADMIN OR CASHIER
export const registerUser = async (req, res) => {
  const { data, error } = validateRegistration(req.body);
  if (error) return res.status(400).json({ message: error });

  let saved;
  try {
    const passwordHash = await hashPassword(data.password);
    const user = await withUserLock(req.user.id, async (tx, admin) => {
      const session = await tx.authSession.findUnique({ where: { id: req.authSession } });
      if (!validSession(session, admin) || admin.role !== 'ADMIN') return null;
      const created = await tx.user.create({ data: { name: data.name, username: data.username, role: data.role, imageUrl: data.imageUrl, passwordHash } });
      if (!req.image) return created;
      saved = await saveImage(req.image, `user/${created.id}`);
      return tx.user.update({ where: { id: created.id }, data: { imageUrl: saved.url } });
    });
    if (!user) return res.status(403).json({ message: 'Administrator permission required' });
    return res.status(201).json({ message: 'User registered successfully', user: safeUser(user) });
  } catch (error) {
    if (saved) await removeImage(saved.url);
    const errors = {
      P2002: { status: 409, message: 'Username already exists' },
    };
    const response = errors[error.code];
    if (response) return res.status(response.status).json({ message: response.message });
    if (error.status === 429) return res.status(429).json({ message: 'Too many authentication requests' });
    return res.status(500).json({ message: 'Server error' });
  }
};
