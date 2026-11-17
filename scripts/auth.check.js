import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
process.env.JWT_SECRET = 'offline-check-secret-32-bytes-long-only';
process.env.APP_ORIGIN = 'http://localhost:3000';
const auth = await import('../src/utils/auth.utils.js');

test('scrypt salts passwords, preserves exact bytes and bounds work', async () => {
  const password = ' Good password! ';
  const hash = await auth.hashPassword(password);
  assert.notEqual(hash, await auth.hashPassword(password));
  assert.ok(await auth.verifyPassword(password, hash));
  assert.equal(await auth.verifyPassword(password.trim(), hash), false);
  assert.equal(await auth.verifyPassword(password, 'broken'), false);
  const jobs = Array.from({ length: 4 }, () => auth.hashPassword(password));
  await assert.rejects(auth.hashPassword(password), { status: 429 });
  await Promise.all(jobs);
  assert.ok(await auth.verifyPassword(password, hash));
});
test('input validation rejects extra fields, malformed Unicode and wrong roles', () => {
  const body = { name: ' Test ', username: 'TEST', password: 'Good password!', role: 'ADMIN' };
  assert.equal(auth.validateRegistration(body).data.username, 'test');
  for (const extra of [{ role: 'USER' }, { id: 1 }, { password: 'short' }, { password: '\ud800'.repeat(12) }, { name: '' }, { username: 'a b' }]) assert.ok(auth.validateRegistration({ ...body, ...extra }).error);
  assert.equal(auth.validateRegistration({ ...body, role: 'CASHIER' }).error, undefined);
  assert.equal(auth.validateLogin({ username: 'TEST', password: body.password }).data.username, 'test');
  assert.ok(auth.validatePasswordChange({ currentPassword: body.password, newPassword: body.password }).error);
});
test('JWT verifies signature, audience, issuer and expiry with minimal claims', async () => {
  const token = auth.createAccessToken(12, 'session');
  assert.equal(auth.verifyAccessToken(token).sub, '12');
  assert.equal(auth.verifyAccessToken(token).sid, 'session');
  assert.throws(() => auth.verifyAccessToken(token + 'x'));
  const { default: jwt } = await import('jsonwebtoken');
  for (const options of [{ algorithm: 'HS384' }, { audience: 'wrong' }, { issuer: 'wrong' }, { expiresIn: -1 }]) {
    const bad = jwt.sign({ sid: 'session' }, process.env.JWT_SECRET, { algorithm: 'HS256', audience: 'opencafe-api', issuer: 'opencafe', subject: '12', expiresIn: 900, ...options });
    assert.throws(() => auth.verifyAccessToken(bad));
  }
  assert.equal(auth.refreshDigest(auth.createRefreshToken()).length, 64);
  assert.deepEqual(auth.safeUser({ id: 1, name: 'Test', username: 'test', role: 'ADMIN', mustChangePassword: true, passwordHash: 'private' }), { id: 1, name: 'Test', username: 'test', role: 'ADMIN', mustChangePassword: true, imageUrl: null });
});
test('migration seed verifies with runtime hashing and keeps applied SQL immutable', async () => {
  for (const name of ['202611170001_baseline', '202611170002_auth']) {
    const path = `prisma/migrations/${name}/migration.sql`;
    assert.equal(readFileSync(path, 'utf8'), execFileSync('git', ['show', `208f302:${path}`], { encoding: 'utf8' }));
  }
  const sql = readFileSync('prisma/migrations/202611170003_default_admin/migration.sql', 'utf8');
  const hash = sql.match(/scrypt\$16384\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{128}/)?.[0];
  assert.ok(await auth.verifyPassword('ChangeMeBeforeUse!', hash));
  assert.ok(sql.includes('must_change_password'));
  assert.ok(!sql.includes('ChangeMeBeforeUse!'));
});
test('mounted routes enforce session state, forced change and roles', async t => {
  const { app } = await import('../src/app.js');
  const { prisma } = await import('../src/configs/prisma.js');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await prisma.$disconnect(); });
  const user = { id: 7, name: 'Test', username: 'test', role: 'CASHIER', isActive: true, mustChangePassword: false };
  const session = { id: 'sid', userId: 7, expiresAt: new Date(Date.now() + 100000), revokedAt: null, user };
  const stub = (delegate, name, fn) => { const original = delegate[name]; delegate[name] = t.mock.fn(fn); t.after(() => { delegate[name] = original; }); };
  stub(prisma.authSession, 'findUnique', async () => session);
  stub(prisma.cafeSetting, 'findUnique', async () => ({ id: 1, name: 'Cafe' }));
  const request = async (path, method = 'GET', token = auth.createAccessToken(7, 'sid'), body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json() };
  };
  assert.equal((await request('/api/cafe', 'GET', null)).status, 401);
  assert.equal((await request('/api/auth/me')).body.user.username, 'test');
  assert.equal((await request('/api/cafe')).status, 200);
  for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await request('/api/cafe', method)).status, 403);
  assert.equal((await request('/api/admin/users', 'POST')).status, 403);
  user.mustChangePassword = true;
  assert.equal((await request('/api/cafe')).body.code, 'PASSWORD_CHANGE_REQUIRED');
  assert.equal((await request('/api/auth/me')).status, 200);
  assert.equal((await request('/api/auth/password', 'PUT', undefined, {})).status, 400);
  user.mustChangePassword = false; user.isActive = false;
  assert.equal((await request('/api/cafe')).status, 401);
  user.isActive = true; session.revokedAt = new Date();
  assert.equal((await request('/api/cafe')).status, 401);
  session.revokedAt = null; user.role = 'ADMIN';
  assert.equal((await request('/api/admin/users', 'POST', undefined, {})).status, 400);
  assert.equal((await request('/api/auth/me', 'GET', 'invalid')).status, 401);
  const bad = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: Buffer.from([0x7b,0xff,0x7d]) });
  assert.equal(bad.status, 400);
  assert.equal((await request('/api/auth/login', 'POST', null, { username: 'x', password: '\ud800'.repeat(12) })).status, 400);
  const cross = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/refresh`, { method: 'POST', headers: { Origin: 'https://evil.example' } });
  assert.equal(cross.status, 403);
});
test('login limiter bounds IP, account and store independently, then recovers', async () => {
  const { createLoginLimiter } = await import('../src/middlewares/auth.middleware.js');
  let now = 0;
  const limiter = createLoginLimiter(() => now);
  const hit = (ip, username) => { let result; limiter({ ip, body: { username } }, { status: value => ({ json: () => { result = value; } }) }, () => { result = 200; }); return result; };
  for (let i = 0; i < 10; i++) assert.equal(hit(`account-ip-${i}`, i % 2 ? 'TEST' : 'test'), 200);
  assert.equal(hit('account-ip-new', 'test'), 429);
  for (let i = 0; i < 20; i++) assert.equal(hit('same-ip', `user-${i}`), 200);
  assert.equal(hit('same-ip', 'user-new'), 429);
  now += 15 * 60000;
  for (let i = 0; i < 10; i++) assert.equal(hit(`invalid-ip-${i}`, 'x'.repeat(1000) + i), 200);
  assert.equal(hit('invalid-ip-new', 'y'.repeat(1000)), 429);
  now += 15 * 60000;
  for (let i = 0; i < 5000; i++) assert.equal(hit(`ip-${i}`, `user-${i}`), 200);
  assert.equal(hit('overflow', 'overflow'), 429);
  now += 15 * 60000;
  assert.equal(hit('overflow', 'overflow'), 200);
});
test('password-change endpoint stops guesses before password verification', async t => {
  const { app } = await import('../src/app.js');
  const { prisma } = await import('../src/configs/prisma.js');
  const user = { id: 99, name: 'Test', username: 'password-limit', role: 'CASHIER', isActive: true, mustChangePassword: false, passwordHash: await auth.hashPassword('Correct password!') };
  const originals = [prisma.authSession.findUnique, prisma.user.findUnique];
  let passwordReads = 0;
  prisma.authSession.findUnique = async () => ({ id: 'limit', userId: user.id, user, expiresAt: new Date(Date.now() + 100000), revokedAt: null });
  prisma.user.findUnique = async () => { passwordReads++; return user; };
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    prisma.authSession.findUnique = originals[0]; prisma.user.findUnique = originals[1];
    await new Promise(resolve => server.close(resolve)); await prisma.$disconnect();
  });
  const attempt = () => fetch(`http://127.0.0.1:${server.address().port}/api/auth/password`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.createAccessToken(99, 'limit')}` }, body: JSON.stringify({ currentPassword: 'Incorrect password!', newPassword: 'Changed password!' }) });
  for (let i = 0; i < 10; i++) assert.equal((await attempt()).status, 401);
  assert.equal(passwordReads, 10);
  assert.equal((await attempt()).status, 429);
  assert.equal(passwordReads, 10);
});
test('authenticated account limits are independent and recover on expiry', async () => {
  const { createLoginLimiter } = await import('../src/middlewares/auth.middleware.js');
  let now = 0;
  const limiter = createLoginLimiter(() => now);
  const hit = (id, ip) => { let status; limiter({ user: { id }, ip }, { status: code => ({ json: () => { status = code; } }) }, () => { status = 200; }); return status; };
  for (let i = 0; i < 10; i++) assert.equal(hit(1, `ip-${i}`), 200);
  assert.equal(hit(1, 'different-ip'), 429);
  assert.equal(hit(2, 'different-ip'), 200);
  now += 15 * 60000;
  assert.equal(hit(1, 'different-ip'), 200);
});
test('missing or malformed JWT secret fails closed', () => {
  for (const secret of ['', 'short', ' '.repeat(32), 'x'.repeat(32) + '\n']) {
    const env = { ...process.env, JWT_SECRET: secret }; delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', "await import('./src/utils/auth.utils.js')"], { env, encoding: 'utf8' });
    assert.notEqual(child.status, 0);
    assert.ok(child.stderr.includes('JWT_SECRET'));
  }
});
