import { hashPassword, safeUser, validateRegistration } from '../utils/auth.utils.js';
import { validSession, withUserLock } from '../utils/session.utils.js';

// REGISTER ADMIN OR CASHIER
export const registerUser = async (req, res) => {
  const { data, error } = validateRegistration(req.body);
  if (error) return res.status(400).json({ message: error });

  try {
    const passwordHash = await hashPassword(data.password);
    const user = await withUserLock(req.user.id, async (tx, admin) => {
      const session = await tx.authSession.findUnique({ where: { id: req.authSession } });
      if (!validSession(session, admin) || admin.role !== 'ADMIN' || admin.mustChangePassword) return null;
      return tx.user.create({ data: { name: data.name, username: data.username, role: data.role, passwordHash, mustChangePassword: true } });
    });
    if (!user) return res.status(403).json({ message: 'Administrator permission required' });
    return res.status(201).json({ message: 'User registered successfully', user: safeUser(user) });
  } catch (error) {
    const errors = {
      P2002: { status: 409, message: 'Username already exists' },
    };
    const response = errors[error.code];
    if (response) return res.status(response.status).json({ message: response.message });
    if (error.status === 429) return res.status(429).json({ message: 'Too many authentication requests' });
    return res.status(500).json({ message: 'Server error' });
  }
};
