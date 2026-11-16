import { fail } from './errors.js';

function object(body, keys) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !keys.includes(key))) throw fail(400, 'INVALID_INPUT');
}
function text(value, min, max) {
  return typeof value === 'string' && [...value].length >= min && [...value].length <= max && !/[\x00-\x1f\x7f]/u.test(value);
}
export function parseLogin(body) {
  object(body, ['username', 'password']);
  if (typeof body.username !== 'string' || !/^[a-zA-Z0-9_.-]{3,100}$/.test(body.username) || !text(body.password, 12, 128) || Buffer.byteLength(body.password) > 512) throw fail(400, 'INVALID_INPUT');
  return { username: body.username.toLowerCase(), password: body.password };
}
export function parseRegister(body) {
  object(body, ['name', 'username', 'password', 'role']);
  const { username, password } = parseLogin({ username: body.username, password: body.password });
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!text(name, 1, 100) || !['ADMIN', 'CASHIER'].includes(body.role)) throw fail(400, 'INVALID_INPUT');
  return { name, username, password, role: body.role };
}
export function safeUser(user) {
  return { id: user.id, name: user.name, username: user.username, role: user.role, isActive: user.isActive };
}
