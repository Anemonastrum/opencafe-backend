
import { prisma } from '../configs/prisma.js';
import { validateCafeSetting } from '../utils/cafe.utils.js';

// Handle errors
const handleError = (res, error) => {
  const errors = {
    P2002: { status: 409, message: 'Settings already exists' },
    P2025: { status: 404, message: 'Settings not found' },
  };

  const response = errors[error.code];

  if (response) {
    return res.status(response.status).json({
      message: response.message,
    });
  }

  console.error('Cafe Setting Error:', error);
  return res.status(500).json({ message: 'Server error' });
};

// CREATE
export const createCafeSetting = async (req, res) => {
  const { data, error } = validateCafeSetting(req.body);

  if (error) {
    return res.status(400).json({ message: error });
  }

  try {
    const cafeSetting = await prisma.cafeSetting.create({
      data: { ...data, id: 1 },
    });

    return res.status(201).json({
      message: 'Cafe settings created successfully',
      cafeSetting,
    });
  } catch (error) {
    return handleError(res, error);
  }
};

// READ
export const getCafeSetting = async (req, res) => {
  try {
    const cafeSetting = await prisma.cafeSetting.findUnique({
      where: { id: 1 },
    });

    if (!cafeSetting) {
      return res.status(404).json({
        message: 'Cafe settings not found',
      });
    }

    return res.json(cafeSetting);
  } catch (error) {
    return handleError(res, error);
  }
};

// UPDATE
export const updateCafeSetting = async (req, res) => {
  const { data, error } = validateCafeSetting(req.body, true);

  if (error) {
    return res.status(400).json({ message: error });
  }

  try {
    const cafeSetting = await prisma.cafeSetting.update({
      where: { id: 1 },
      data,
    });

    return res.json({
      message: 'Cafe settings updated successfully',
      cafeSetting,
    });
  } catch (error) {
    return handleError(res, error);
  }
};

// DELETE
export const deleteCafeSetting = async (req, res) => {
  try {
    await prisma.cafeSetting.delete({
      where: { id: 1 },
    });

    return res.json({
      message: 'Cafe settings deleted successfully',
    });
  } catch (error) {
    return handleError(res, error);
  }
};
