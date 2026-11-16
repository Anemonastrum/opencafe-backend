import { prisma } from '../configs/prisma.js';
import { validateCafeSetting } from '../utils/cafeSettingValidation.js';

// buat pengaturan cafe, cuma satu data dengan id 1
export const createCafeSetting = async (req, res) => {
  const { data, error } = validateCafeSetting(req.body);
  if (error) return res.status(400).json({ message: error });

  try {
    const cafeSetting = await prisma.cafeSetting.create({ data: { id: 1, ...data } });
    res.status(201).json({ message: 'ok', cafeSetting });
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ message: 'pengaturan cafe sudah ada, update saja' });
    res.status(500).json({ message: 'server error' });
  }
};

// ambil pengaturan cafe
export const getCafeSetting = async (req, res) => {
  try {
    const cafeSetting = await prisma.cafeSetting.findUnique({ where: { id: 1 } });
    if (!cafeSetting) return res.status(404).json({ message: 'pengaturan cafe tidak ditemukan' });

    res.json(cafeSetting);
  } catch (err) {
    res.status(500).json({ message: 'server error' });
  }
};

// update field yang dikirim saja
export const updateCafeSetting = async (req, res) => {
  const { data, error } = validateCafeSetting(req.body, true);
  if (error) return res.status(400).json({ message: error });

  try {
    const cafeSetting = await prisma.cafeSetting.update({ where: { id: 1 }, data });
    res.json({ message: 'ok', cafeSetting });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ message: 'pengaturan cafe tidak ditemukan' });
    res.status(500).json({ message: 'server error' });
  }
};

// hapus pengaturan cafe
export const deleteCafeSetting = async (req, res) => {
  try {
    await prisma.cafeSetting.delete({ where: { id: 1 } });
    res.json({ message: 'ok' });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ message: 'pengaturan cafe tidak ditemukan' });
    res.status(500).json({ message: 'server error' });
  }
};
