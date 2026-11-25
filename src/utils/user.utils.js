export const safeUser = user => ({ id: user.id, name: user.name, username: user.username, role: user.role, imageUrl: user.imageUrl ?? null });
export const safeCashier = user => ({ ...safeUser(user), isActive: user.isActive });

export const passwordValid = value => typeof value === 'string' && value.isWellFormed() && Buffer.byteLength(value) >= 8 && Buffer.byteLength(value) <= 128;

export const validateProfile = (body, admin = false) => {
  const fields = ['name', 'username', 'imageUrl', ...(admin ? ['isActive'] : [])];
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length || Object.keys(body).some(key => !fields.includes(key))) return { error: 'Valid profile fields required' };
  const data = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === 'name') {
      if (typeof value !== 'string' || !value.isWellFormed() || !value.trim() || [...value.trim()].length > 100) return { error: 'Name must contain 1–100 characters' };
      data.name = value.trim();
    }
    if (key === 'username') {
      if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(value)) return { error: 'Invalid username' };
      data.username = value.toLowerCase();
    }
    if (key === 'isActive') {
      if (typeof value !== 'boolean') return { error: 'isActive must be boolean' };
      data.isActive = value;
    }
    if (key === 'imageUrl') {
      if (value === null) { data.imageUrl = null; continue; }
      return { error: 'Upload an image instead of supplying imageUrl' };
    }
  }
  return { data };
};
export const validateResetPassword = body => {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !passwordValid(body.newPassword)) return { error: 'newPassword must contain 8–128 UTF-8 bytes' };
  return { data: { newPassword: body.newPassword } };
};
export const parseUserId = value => typeof value === 'string' && /^[1-9]\d{0,9}$/.test(value) && Number(value) <= 2147483647 ? Number(value) : null;
export const parseCashierPage = query => {
  if (Object.keys(query).some(key => !['page', 'limit'].includes(key))) return { error: 'Invalid pagination fields' };
  const page = query.page === undefined ? 1 : parseUserId(query.page);
  const limit = query.limit === undefined ? 20 : parseUserId(query.limit);
  if (!page || !limit || limit > 100 || (page - 1) * limit > 2147483647) return { error: 'Invalid page or limit' };
  return { data: { page, limit } };
};
