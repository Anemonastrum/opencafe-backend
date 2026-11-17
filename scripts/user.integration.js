import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
const target = `${process.env.DATABASE_HOST}:${process.env.DATABASE_PORT || 3306}/${process.env.DATABASE_NAME}`;
assert.equal(process.env.AUTH_TEST_DATABASE_ACK, target, 'Explicit test target acknowledgement required');
assert.equal(process.env.DATABASE_NAME, 'pos_auth_test');
process.env.JWT_SECRET = randomBytes(32).toString('hex');
const { app } = await import('../src/app.js');
const { prisma } = await import('../src/configs/prisma.js');
const { hashPassword } = await import('../src/utils/auth.utils.js');

test('real profile editing, cashier management, reset/deactivation lifecycle and races', async t => {
  const before = await prisma.user.count();
  const ids = [];
  const prefix = `profile_${randomBytes(5).toString('hex')}`;
  const password = 'Fixture password!';
  const resetPassword = 'Reset fixture password!';
  // Controlled test harness only: distinct client IPs keep independent cases out of IP budget.
  app.set('trust proxy', true);
  let client = 0;
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const request = async (path, method = 'GET', body, token, cookie) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.0.${Math.floor(++client / 250)}.${client % 250 + 1}`, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    assert.ok(!text.includes('passwordHash') && !text.includes('password_hash') && !text.includes('scrypt$'));
    return { status: res.status, body: JSON.parse(text), cookie: res.headers.get('set-cookie')?.split(';')[0] };
  };
  const login = (username, secret = password) => request('/api/auth/login', 'POST', { username, password: secret });
  try {
    const hash = await hashPassword(password);
    // Create target before actor to exercise ascending locks with target ID lower than admin.
    const cashier = await prisma.user.create({ data: { name: 'Cashier', username: prefix + '_cashier', passwordHash: hash } }); ids.push(cashier.id);
    const admin = await prisma.user.create({ data: { name: 'Admin', username: prefix + '_admin', passwordHash: hash, role: 'ADMIN' } }); ids.push(admin.id);
    const adminSession = await login(admin.username);
    const token = adminSession.body.accessToken;
    let signed = await login(cashier.username);
    assert.equal(signed.body.user.imageUrl, null);
    for (const session of [adminSession, signed]) {
      const updated = await request('/api/auth/profile', 'PUT', { name: ' Changed ', imageUrl: null }, session.body.accessToken);
      assert.equal(updated.status, 200); assert.equal(updated.body.user.name, 'Changed');
      assert.equal(updated.body.user.imageUrl, null);
      assert.equal((await request('/api/auth/me', 'GET', undefined, session.body.accessToken)).body.user.imageUrl, null);
    }
    const changedUsername = prefix + '_new';
    assert.equal((await request('/api/auth/profile', 'PUT', { username: changedUsername }, signed.body.accessToken)).status, 200);
    assert.equal((await request('/api/auth/profile', 'PUT', { username: admin.username }, signed.body.accessToken)).status, 409);
    assert.equal((await request('/api/auth/profile', 'PUT', { role: 'ADMIN' }, signed.body.accessToken)).status, 400);
    assert.equal((await request('/api/auth/profile', 'PUT', { isActive: false }, signed.body.accessToken)).status, 400);
    const renewed = await request('/api/auth/refresh', 'POST', undefined, undefined, signed.cookie);
    assert.equal(renewed.body.user.imageUrl, null);
    signed = await login(changedUsername);
    assert.equal(signed.body.user.imageUrl, null);
    const list = await request('/api/admin/cashiers?limit=100', 'GET', undefined, token);
    assert.equal(list.status, 200); assert.ok(list.body.cashiers.some(user => user.id === cashier.id));
    assert.ok(list.body.cashiers.every(user => user.role === 'CASHIER' && typeof user.isActive === 'boolean'));
    assert.equal((await request('/api/admin/cashiers', 'GET', undefined, signed.body.accessToken)).status, 403);
    const path = `/api/admin/cashiers/${cashier.id}`;
    assert.equal((await request(path, 'GET', undefined, token)).body.cashier.imageUrl, null);
    const edited = await request(path, 'PUT', { name: 'Edited cashier', imageUrl: null }, token);
    assert.equal(edited.status, 200); assert.equal(edited.body.cashier.imageUrl, null);
    assert.equal((await request(`/api/admin/cashiers/${admin.id}`, 'GET', undefined, token)).status, 404);
    assert.equal((await request(`/api/admin/cashiers/${admin.id}`, 'PUT', { isActive: false }, token)).status, 404);
    assert.equal((await request(`/api/admin/cashiers/${admin.id}/password`, 'PUT', { newPassword: resetPassword }, token)).status, 404);
    assert.equal((await request(path, 'PUT', { isActive: false }, token)).status, 200);
    assert.equal((await request('/api/auth/me', 'GET', undefined, signed.body.accessToken)).status, 401);
    assert.equal((await request(path, 'PUT', { isActive: true }, token)).status, 200);
    assert.equal((await request('/api/auth/me', 'GET', undefined, signed.body.accessToken)).status, 401);
    signed = await login(changedUsername);
    const reset = await request(path + '/password', 'PUT', { newPassword: resetPassword }, token);
    assert.equal(reset.status, 200);
    assert.equal((await request('/api/auth/me', 'GET', undefined, signed.body.accessToken)).status, 401);
    assert.equal((await login(changedUsername)).status, 401);
    const resetLogin = await login(changedUsername, resetPassword);
    assert.equal(resetLogin.body.user.mustChangePassword, true);
    assert.equal((await request('/api/auth/profile', 'PUT', { name: 'No' }, resetLogin.body.accessToken)).status, 403);
    assert.equal((await request('/api/auth/password', 'PUT', { currentPassword: resetPassword, newPassword: password }, resetLogin.body.accessToken)).status, 200);

    // Actual production transaction callback paused after SQL; second writer uses separate connection.
    const race = async (first, second) => {
      const original = prisma.$transaction;
      let enter, release, secondEnter;
      const held = new Promise(resolve => { enter = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      const started = new Promise(resolve => { secondEnter = resolve; });
      let calls = 0;
      prisma.$transaction = (callback, options) => original.call(prisma, async tx => {
        const n = ++calls;
        if (n === 2) secondEnter();
        const result = await callback(tx);
        if (n === 1) { enter(); await gate; }
        return result;
      }, options);
      const deadline = promise => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('Transaction barrier timeout')), 5000).unref())]);
      let a, b;
      try { a = first(); await deadline(held); b = second(); await deadline(started); release(); return await Promise.all([a, b]); }
      finally { release(); await Promise.allSettled([a, b].filter(Boolean)); prisma.$transaction = original; }
    };
    for (const mutation of ['reset', 'deactivate']) for (const action of ['login', 'refresh']) for (const mutationFirst of [true, false]) {
      // Re-establish fixture-only credentials and active state between independent race cases.
      const caseUsername = `${prefix}_${mutation}_${action}_${mutationFirst}`;
      await prisma.user.update({ where: { id: cashier.id }, data: { username: caseUsername, passwordHash: hash, isActive: true, mustChangePassword: false } });
      const current = await login(caseUsername);
      assert.equal(current.status, 200);
      const mutate = () => mutation === 'reset' ? request(path + '/password', 'PUT', { newPassword: resetPassword }, token) : request(path, 'PUT', { isActive: false }, token);
      const other = () => action === 'login' ? login(caseUsername) : request('/api/auth/refresh', 'POST', undefined, undefined, current.cookie);
      const results = await race(mutationFirst ? mutate : other, mutationFirst ? other : mutate);
      assert.equal(results[mutationFirst ? 0 : 1].status, 200);
      const concurrent = results[mutationFirst ? 1 : 0];
      assert.equal(concurrent.status, mutationFirst ? 401 : 200);
      assert.equal(await prisma.authSession.count({ where: { userId: cashier.id, revokedAt: null } }), 0);
      assert.equal((await request('/api/auth/me', 'GET', undefined, current.body.accessToken)).status, 401);
      if (concurrent.body.accessToken) assert.equal((await request('/api/auth/me', 'GET', undefined, concurrent.body.accessToken)).status, 401);
    }
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    assert.equal(await prisma.user.count(), before);
    await new Promise(resolve => server.close(resolve));
    await prisma.$disconnect();
  }
});
