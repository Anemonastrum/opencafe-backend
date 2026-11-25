import { prisma } from '../configs/prisma.js';
import { validateCafeSetting } from '../utils/cafe.utils.js';
import { saveImage, removeImage } from '../utils/image.utils.js';
import { validSession, withUserLock } from '../utils/session.utils.js';

const handleError = (res, error) => {
  const errors = { P2002: { status: 409, message: 'Settings already exists' }, P2025: { status: 404, message: 'Settings not found' } };
  const response = errors[error.code];
  if (response) return res.status(response.status).json({ message: response.message });
  return res.status(error.status === 403 ? 403 : 500).json({ message: error.status === 403 ? 'Administrator permission required' : 'Server error' });
};

const withCafeLock = (req, callback) => withUserLock(req.user.id, async (tx, admin) => {
  const session = await tx.authSession.findUnique({ where: { id: req.authSession } });
  if (!validSession(session, admin) || admin.role !== 'ADMIN') throw Object.assign(new Error('Permission denied'), { status: 403 });
  await tx.$queryRaw`SELECT id FROM cafe_settings WHERE id = 1 FOR UPDATE`;
  return callback(tx);
});

// CREATE
export const createCafeSetting = async (req, res) => {
  const { data, error } = validateCafeSetting(req.body);
  if (error) return res.status(400).json({ message: error });
  let saved;
  try {
    const cafeSetting = await withCafeLock(req, async tx => {
      if (req.image) { saved = await saveImage(req.image, 'cafe'); data.logoUrl = saved.url; }
      return tx.cafeSetting.create({ data: { ...data, id: 1 } });
    });
    return res.status(201).json({ message: 'Cafe settings created successfully', cafeSetting });
  } catch (error) { if (saved) await removeImage(saved.url); return handleError(res, error); }
};

export const getCafeBranding = async (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  try {
    const branding = await prisma.cafeSetting.findUnique({
      where: { id: 1 },
      select: { name: true, logoUrl: true },
    });
    if (!branding) return res.status(404).json({ message: 'Cafe settings not found' });
    return res.json(branding);
  } catch {
    return res.status(500).json({ message: 'Server error' });
  }
};

// READ
export const getCafeSetting = async (req, res) => {
  try {
    const cafeSetting = await prisma.cafeSetting.findUnique({ where: { id: 1 } });
    if (!cafeSetting) return res.status(404).json({ message: 'Cafe settings not found' });
    return res.json(cafeSetting);
  } catch (error) { return handleError(res, error); }
};

// UPDATE
export const updateCafeSetting = async (req, res) => {
  const { data, error } = validateCafeSetting(req.body, true);
  if (error) return res.status(400).json({ message: error });
  let saved, previous;
  try {
    const cafeSetting = await withCafeLock(req, async tx => {
      const current = await tx.cafeSetting.findUnique({ where: { id: 1 } });
      if (!current) throw Object.assign(new Error('Settings not found'), { code: 'P2025' });
      previous = current.logoUrl;
      if (req.image) { saved = await saveImage(req.image, 'cafe'); data.logoUrl = saved.url; }
      return tx.cafeSetting.update({ where: { id: 1 }, data });
    });
    if (Object.hasOwn(data, 'logoUrl')) await removeImage(previous);
    return res.json({ message: 'Cafe settings updated successfully', cafeSetting });
  } catch (error) { if (saved) await removeImage(saved.url); return handleError(res, error); }
};

// DELETE
export const deleteCafeSetting = async (req, res) => {
  try {
    const deleted = await withCafeLock(req, tx => tx.cafeSetting.delete({ where: { id: 1 } }));
    await removeImage(deleted.logoUrl);
    return res.json({ message: 'Cafe settings deleted successfully' });
  } catch (error) { return handleError(res, error); }
};
