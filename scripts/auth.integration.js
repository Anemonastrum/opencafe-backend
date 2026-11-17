import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const target = `${process.env.DATABASE_HOST}:${process.env.DATABASE_PORT || 3306}/${process.env.DATABASE_NAME}`;
assert.equal(process.env.AUTH_TEST_DATABASE_ACK, target, 'Explicit AUTH_TEST_DATABASE_ACK=host:port/database required');
assert.equal(process.env.DATABASE_NAME, 'pos_auth_test', 'Fixture writes restricted to authorized pos_auth_test');
process.env.JWT_SECRET = randomBytes(32).toString('hex');
process.env.APP_ORIGIN = 'http://localhost:3000';
const { app } = await import('../src/app.js');
const { prisma } = await import('../src/configs/prisma.js');
const { hashPassword, verifyPassword } = await import('../src/utils/auth.utils.js');
const password = 'Fixture password!';
const newPassword = 'Fixture changed password!';
const prefix = `check_${randomBytes(5).toString('hex')}`;

// Every fixture identity recorded; existing seeded admin never changed or removed.
test('real MariaDB mounted JWT lifecycle, admin registration and role privileges', async t => {
  const before = await prisma.user.count();
  const ids = [];
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const request = async (path, { method = 'GET', token, cookie, body } = {}) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    assert.ok(!text.includes('passwordHash') && !text.includes('password_hash') && !text.includes('scrypt$'));
    return { status: res.status, body: text ? JSON.parse(text) : null, cookie: res.headers.get('set-cookie')?.split(';')[0], headers: res.headers };
  };
  const signIn = (username, secret = password) => request('/api/auth/login', { method: 'POST', body: { username, password: secret } });
  try {
    const seeded = await prisma.user.findUnique({ where: { username: 'admin' } });
    assert.equal(seeded.role, 'ADMIN');
    assert.equal(seeded.mustChangePassword, true);
    assert.ok(await verifyPassword('ChangeMeBeforeUse!', seeded.passwordHash));
    const admin = await prisma.user.create({ data: { name: 'Fixture admin', username: prefix, passwordHash: await hashPassword(password), role: 'ADMIN' } });
    ids.push(admin.id);
    let signed = await signIn(prefix);
    assert.equal(signed.status, 200);
    assert.ok(signed.headers.get('set-cookie').includes('HttpOnly'));
    assert.ok(signed.headers.get('set-cookie').includes('SameSite=Strict'));
    assert.ok(signed.headers.get('set-cookie').includes('Path=/api/auth'));
    assert.equal(signed.headers.get('cache-control'), 'no-store');
    const adminToken = signed.body.accessToken;
    for (const role of ['CASHIER', 'ADMIN']) {
      const username = `${prefix}_${role.toLowerCase()}`;
      const created = await request('/api/admin/users', { method: 'POST', token: adminToken, body: { name: role, username, password, role } });
      assert.equal(created.status, 201);
      ids.push(created.body.user.id);
      assert.equal(created.body.user.role, role);
      assert.equal(created.body.user.mustChangePassword, true);
    }
    const duplicate = await request('/api/admin/users', { method: 'POST', token: adminToken, body: { name: 'Duplicate', username: prefix.toUpperCase(), password } });
    assert.equal(duplicate.status, 409);
    const username = `${prefix}_cashier`;
    const forced = await signIn(username);
    assert.equal((await request('/api/cafe', { token: forced.body.accessToken })).body.code, 'PASSWORD_CHANGE_REQUIRED');
    assert.equal((await request('/api/auth/me', { token: forced.body.accessToken })).status, 200);
    assert.equal((await request('/api/auth/password', { method: 'PUT', token: forced.body.accessToken, body: { currentPassword: 'Incorrect password!', newPassword } })).status, 401);
    const changed = await request('/api/auth/password', { method: 'PUT', token: forced.body.accessToken, body: { currentPassword: password, newPassword } });
    assert.equal(changed.status, 200);
    assert.ok(changed.headers.get('set-cookie').includes('Expires=Thu, 01 Jan 1970'));
    assert.equal((await request('/api/auth/me', { token: forced.body.accessToken })).status, 401);
    assert.equal((await signIn(username)).status, 401);
    const cashier = await signIn(username, newPassword);
    assert.equal(cashier.body.user.mustChangePassword, false);
    assert.equal((await request('/api/cafe', { token: cashier.body.accessToken })).status, 404);
    for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await request('/api/cafe', { method, token: cashier.body.accessToken, body: {} })).status, 403);
    assert.equal((await request('/api/admin/users', { method: 'POST', token: cashier.body.accessToken, body: {} })).status, 403);
    // Prove live role/account state overrides already-issued JWT.
    await prisma.user.update({ where: { id: admin.id }, data: { role: 'CASHIER' } });
    assert.equal((await request('/api/admin/users', { method: 'POST', token: adminToken, body: {} })).status, 403);
    await prisma.user.update({ where: { id: admin.id }, data: { role: 'ADMIN', isActive: false } });
    assert.equal((await request('/api/auth/me', { token: adminToken })).status, 401);
    await prisma.user.update({ where: { id: admin.id }, data: { isActive: true } });
    const expiry = await prisma.authSession.findFirst({ where: { userId: admin.id } });
    const rotated = await request('/api/auth/refresh', { method: 'POST', cookie: signed.cookie });
    assert.equal(rotated.status, 200);
    assert.notEqual(rotated.cookie, signed.cookie);
    assert.equal((await prisma.authSession.findUnique({ where: { id: expiry.id } })).expiresAt.getTime(), expiry.expiresAt.getTime());
    assert.equal((await request('/api/auth/refresh', { method: 'POST', cookie: signed.cookie })).status, 401);
    assert.ok((await prisma.authSession.findUnique({ where: { id: expiry.id } })).revokedAt);
    assert.equal((await request('/api/auth/me', { token: rotated.body.accessToken })).status, 401);
    assert.equal((await request('/api/auth/refresh', { method: 'POST', cookie: rotated.cookie })).status, 401);
    signed = await signIn(prefix);
    const concurrent = await Promise.all([1, 2].map(() => request('/api/auth/refresh', { method: 'POST', cookie: signed.cookie })));
    assert.deepEqual(concurrent.map(value => value.status).sort(), [200, 401]);
    const winner = concurrent.find(value => value.status === 200);
    assert.equal((await request('/api/auth/me', { token: winner.body.accessToken })).status, 401);
    // Pause first writer after SQL but before commit; second writer must recheck state.
    const race = async (first, second) => {
      const original = prisma.$transaction;
      let enter, release, secondEntered;
      const held = new Promise(resolve => { enter = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      const started = new Promise(resolve => { secondEntered = resolve; });
      let calls = 0;
      prisma.$transaction = (callback, options) => original.call(prisma, async tx => {
        calls++;
        const count = calls;
        if (count === 2) secondEntered();
        const result = await callback(tx);
        if (count === 1) { enter(); await gate; }
        return result;
      }, options);
      let firstRequest, secondRequest;
      try {
        firstRequest = first();
        await Promise.race([held, new Promise((_, reject) => setTimeout(() => reject(new Error('First transaction barrier timeout')), 5000).unref())]);
        secondRequest = second();
        await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(new Error('Second transaction barrier timeout')), 5000).unref())]);
        release();
        return await Promise.all([firstRequest, secondRequest]);
      } finally {
        release();
        await Promise.allSettled([firstRequest, secondRequest].filter(Boolean));
        prisma.$transaction = original;
      }
    };
    const secondary = `${prefix}_admin`;
    let secondaryPassword = password;
    for (const action of ['login', 'refresh']) {
      for (const passwordFirst of [true, false]) {
        const active = await signIn(secondary, secondaryPassword);
        const changedPassword = secondaryPassword === password ? newPassword : password;
        const change = () => request('/api/auth/password', { method: 'PUT', token: active.body.accessToken, body: { currentPassword: secondaryPassword, newPassword: changedPassword } });
        const other = () => action === 'login' ? signIn(secondary, secondaryPassword) : request('/api/auth/refresh', { method: 'POST', cookie: active.cookie });
        const results = await race(passwordFirst ? change : other, passwordFirst ? other : change);
        const changedResult = results[passwordFirst ? 0 : 1];
        assert.equal(changedResult.status, 200);
        const otherResult = results[passwordFirst ? 1 : 0];
        assert.equal(otherResult.status, passwordFirst ? 401 : 200);
        if (otherResult.body.accessToken) assert.equal((await request('/api/auth/me', { token: otherResult.body.accessToken })).status, 401);
        assert.equal(await prisma.authSession.count({ where: { userId: ids[2], revokedAt: null } }), 0);
        secondaryPassword = changedPassword;
      }
    }
    signed = await signIn(prefix);
    assert.equal((await request('/api/auth/logout', { method: 'POST', cookie: signed.cookie })).status, 200);
    assert.equal((await request('/api/auth/me', { token: signed.body.accessToken })).status, 401);
    assert.equal((await request('/api/auth/logout', { method: 'POST' })).status, 200);
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    assert.equal(await prisma.user.count(), before);
    await new Promise(resolve => server.close(resolve));
    await prisma.$disconnect();
  }
});
