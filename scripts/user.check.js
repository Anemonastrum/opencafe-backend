import test from 'node:test';
import assert from 'node:assert/strict';
process.env.JWT_SECRET = 'offline-user-check-secret-at-least-32-bytes';
const utils = await import('../src/utils/user.utils.js');
const auth = await import('../src/utils/auth.utils.js');

test('partial profile allowlist preserves null and false; validates URLs and text', () => {
  assert.deepEqual(utils.validateProfile({ name: ' Test ', username: 'TEST', imageUrl: null }).data, { name: 'Test', username: 'test', imageUrl: null });
  assert.deepEqual(utils.validateProfile({ isActive: false }, true).data, { isActive: false });
  for (const body of [null, [], {}, { role: 'ADMIN' }, { id: 1 }, { password: 'secret' }, { isActive: true }, { name: '' }, { username: 'a b' }, { imageUrl: '' }, { imageUrl: 'javascript:alert(1)' }, { imageUrl: 'https://user:pass@example.com/a' }, { imageUrl: 'https://example.com/\n' }, { imageUrl: 'https://example.com/' + 'a'.repeat(500) }, { name: '\ud800' }]) assert.ok(utils.validateProfile(body).error, JSON.stringify(body));
  assert.ok(utils.validateProfile({ imageUrl: 'https://example.com/avatar.png' }).error);
  assert.ok(utils.validateProfile({ isActive: 'false' }, true).error);
  assert.equal(utils.validateResetPassword({ newPassword: 'Changed password!' }).error, undefined);
  assert.ok(utils.validateResetPassword({ newPassword: 'short' }).error);
  assert.ok(utils.validateResetPassword({ newPassword: 'Changed password!', role: 'ADMIN' }).error);
});
test('profile and registration reject Unicode control characters in image URLs', () => {
  for (const control of ['\u0080', '\u0085', '\u009f']) {
    const imageUrl = `https://example.com/${control}avatar.png`;
    assert.ok(utils.validateProfile({ imageUrl }).error, JSON.stringify(imageUrl));
    assert.ok(auth.validateRegistration({ name: 'Test', username: 'test', password: 'Fixture password!', imageUrl }).error, JSON.stringify(imageUrl));
  }
});
test('mounted profile and cashier routes enforce roles, allowlists and target scope', async t => {
  const { app } = await import('../src/app.js');
  const { prisma } = await import('../src/configs/prisma.js');
  const user = { id: 1, name: 'Admin', username: 'admin', role: 'ADMIN', isActive: true, mustChangePassword: false };
  const stub = (delegate, key, fn) => { const original = delegate[key]; delegate[key] = fn; t.after(() => { delegate[key] = original; }); };
  stub(prisma.authSession, 'findUnique', async () => ({ id: 'session', userId: 1, user, expiresAt: new Date(Date.now() + 100000), revokedAt: null }));
  stub(prisma.user, 'findMany', async () => [{ ...user, id: 2, role: 'CASHIER' }]);
  stub(prisma.user, 'count', async () => 1);
  stub(prisma.user, 'findFirst', async () => null);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await prisma.$disconnect(); });
  const request = async (path, method = 'GET', body, token = auth.createAccessToken(1, 'session')) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, text: await res.text() };
  };
  assert.equal((await request('/api/admin/cashiers', 'GET', undefined, null)).status, 401);
  const list = await request('/api/admin/cashiers');
  assert.equal(list.status, 200); assert.ok(!list.text.includes('passwordHash'));
  assert.equal((await request('/api/admin/cashiers/2')).status, 404);
  assert.equal((await request('/api/admin/cashiers/0')).status, 400);
  assert.equal((await request('/api/admin/cashiers?limit=101')).status, 400);
  assert.equal((await request('/api/auth/profile', 'PUT', { role: 'ADMIN' })).status, 400);
  assert.equal((await request('/api/admin/cashiers/2', 'PUT', { role: 'ADMIN' })).status, 400);
  assert.equal((await request('/api/admin/cashiers/2/password', 'PUT', { newPassword: 'short' })).status, 400);
  user.role = 'CASHIER';
  for (const [path, method] of [['/api/admin/cashiers', 'GET'], ['/api/admin/cashiers/2', 'GET'], ['/api/admin/cashiers/2', 'PUT'], ['/api/admin/cashiers/2/password', 'PUT']]) assert.equal((await request(path, method)).status, 403);
  user.mustChangePassword = true;
  assert.equal((await request('/api/auth/profile', 'PUT', { name: 'Test' })).status, 403);
});
test('IDs and pagination bounded; safe projection and registration include imageUrl', () => {
  for (const id of ['0', '-1', '1.0', '01', '2147483648', '1e2', '']) assert.equal(utils.parseUserId(id), null);
  assert.equal(utils.parseUserId('2147483647'), 2147483647);
  assert.deepEqual(utils.parseCashierPage({}).data, { page: 1, limit: 20 });
  for (const query of [{ page: '0' }, { limit: '101' }, { page: ['1','2'] }, { other: '1' }, { page: '10000000000' }]) assert.ok(utils.parseCashierPage(query).error);
  const user = { id: 1, name: 'Test', username: 'test', role: 'CASHIER', isActive: false, mustChangePassword: false, imageUrl: 'https://example.com/a', passwordHash: 'private' };
  assert.equal(auth.safeUser(user).imageUrl, user.imageUrl);
  assert.equal(utils.safeCashier(user).isActive, false);
  assert.equal(auth.safeUser({ ...user, imageUrl: undefined }).imageUrl, null);
  const registration = auth.validateRegistration({ name: 'Test', username: 'test', password: 'Fixture password!', imageUrl: null });
  assert.equal(registration.data.imageUrl, null);
});
