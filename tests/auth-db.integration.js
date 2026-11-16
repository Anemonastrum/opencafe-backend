import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { testDatabase, barrier } from './db-helper.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/utils/config.js';
import jwt from 'jsonwebtoken';
import { createSession, rotateSession, revokeSession, createFirstAdmin } from '../src/utils/sessions.js';
import { digestToken, hashPassword } from '../src/utils/auth.js';

const config = loadConfig({ JWT_SECRET: 't'.repeat(48), APP_ORIGIN: 'http://localhost:3000' });
const db = testDatabase();
async function http(t, injected = db, options = config) {
  const server = createApp({ prisma: injected, config: options }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return async (path, { method = 'POST', body, token, cookie, headers = {} } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth${path}`, {
      method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
}
test.after(() => db.$disconnect());

test('mounted admin/cashier matrix, live DB role and active checks', async t => {
  const user = await fixture(t);
  const request = await http(t);
  const login = await request('/login', { body: { username: user.username, password: 'correct horse battery' } });
  assert.equal(login.status, 200);
  assert.equal(login.body.expiresIn, 900);
  assert.deepEqual(Object.keys(login.body).sort(), ['accessToken', 'expiresIn', 'user']);
  assert.equal(JSON.stringify(login.body).includes('passwordHash'), false);
  assert.match(login.headers.get('set-cookie'), /HttpOnly/);
  assert.match(login.headers.get('set-cookie'), /SameSite=Strict/);
  assert.match(login.headers.get('set-cookie'), /Path=\/api\/auth/);
  assert.equal(login.headers.get('cache-control'), 'no-store');
  const token = login.body.accessToken;
  assert.equal((await request('/me', { method: 'GET', token })).body.user.role, 'CASHIER');
  const input = { name: 'New User', username: 't_' + randomUUID(), password: 'correct horse battery', role: 'ADMIN' };
  assert.equal((await request('/register', { body: input })).status, 401);
  assert.equal((await request('/register', { token, body: input })).status, 403);
  await db.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } });
  for (const role of ['ADMIN', 'CASHIER']) {
    const body = { ...input, username: 't_' + randomUUID(), role };
    const created = await request('/register', { token, body });
    assert.equal(created.status, 201);
    t.after(() => db.user.delete({ where: { id: created.body.user.id } }));
    assert.equal(created.body.user.role, role);
    assert.equal((await request('/register', { token, body })).status, 409);
  }
  assert.equal((await request('/register', { token, body: { ...input, role: 'OWNER' } })).status, 400);
  await db.user.update({ where: { id: user.id }, data: { role: 'CASHIER' } });
  assert.equal((await request('/register', { token, body: input })).status, 403);
  await db.user.update({ where: { id: user.id }, data: { isActive: false } });
  assert.equal((await request('/me', { method: 'GET', token })).status, 401);
  assert.equal((await request('/refresh', { cookie: login.cookie })).status, 401);
});

test('mounted refresh replay and logout revoke issued access JWT immediately', async t => {
  const user = await fixture(t), request = await http(t);
  const login = () => request('/login', { body: { username: user.username, password: 'correct horse battery' } });
  const first = await login();
  const next = await request('/refresh', { cookie: first.cookie });
  assert.equal(next.status, 200);
  assert.notEqual(next.cookie, first.cookie);
  assert.equal((await request('/me', { method: 'GET', token: next.body.accessToken })).status, 200);
  const replay = await request('/refresh', { cookie: first.cookie });
  assert.equal(replay.status, 401);
  assert.match(replay.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/);
  assert.equal((await request('/me', { method: 'GET', token: next.body.accessToken })).status, 401);
  const last = await login();
  assert.equal((await request('/logout', { cookie: last.cookie })).status, 204);
  assert.equal((await request('/logout', { cookie: last.cookie })).status, 204);
  assert.equal((await request('/logout')).status, 204);
  assert.equal((await request('/me', { method: 'GET', token: last.body.accessToken })).status, 401);
});

test('mounted validation, CSRF, expiry, JWT claims and generic credential errors', async t => {
  const user = await fixture(t), request = await http(t);
  const good = { username: user.username, password: 'correct horse battery' };
  const wrong = await request('/login', { body: { ...good, password: 'wrong password here' } });
  const unknown = await request('/login', { body: { ...good, username: 'missing-user' } });
  assert.equal(wrong.status, 401); assert.deepEqual(wrong.body, unknown.body);
  await db.user.update({ where: { id: user.id }, data: { isActive: false } });
  assert.deepEqual((await request('/login', { body: good })).body, wrong.body);
  await db.user.update({ where: { id: user.id }, data: { isActive: true } });
  for (const body of [null, [], {}, { ...good, extra: true }, '{bad', 'x'.repeat(9000)]) assert.equal((await request('/login', { body })).status, 400);
  assert.equal((await request('/login', { body: good, headers: { 'X-Requested-With': '' } })).status, 403);
  assert.equal((await request('/refresh', { headers: { Origin: 'https://evil.test' } })).status, 403);
  assert.equal((await request('/refresh')).status, 401);
  const login = await request('/login', { body: good });
  for (const token of [login.body.accessToken+'x', 'none', jwt.sign({ sid: randomUUID() }, config.jwtSecret, { algorithm: 'HS384', subject: String(user.id), issuer: config.issuer, audience: config.audience, expiresIn: 900 })]) assert.equal((await request('/me', { method: 'GET', token })).status, 401);
  const payload = jwt.decode(login.body.accessToken);
  for (const changes of [{ exp: 1 }, { iss: 'foreign' }, { aud: 'foreign' }, { sub: '1e2' }]) {
    const token = jwt.sign({ ...payload, ...changes }, config.jwtSecret);
    assert.equal((await request('/me', { method: 'GET', token })).status, 401);
  }
  await db.authSession.update({ where: { id: payload.sid }, data: { expiresAt: new Date(0) } });
  assert.equal((await request('/me', { method: 'GET', token: login.body.accessToken })).status, 401);
  assert.equal((await request('/refresh', { cookie: login.cookie })).status, 401);
});

test('mounted throttle rejects excess attempts and hides unexpected DB errors', async t => {
  const request = await http(t);
  for (let i=0; i<10; i++) assert.equal((await request('/login', { body: { username: 'absent-throttled', password: 'wrong password here' } })).status, 401);
  const limited = await request('/login', { body: { username: 'absent-throttled', password: 'wrong password here' } });
  assert.equal(limited.status, 429); assert.ok(limited.headers.get('retry-after'));
  const broken = await http(t, { user: { findUnique() { throw new Error('private database detail'); } } });
  const result = await broken('/login', { body: { username: 'valid', password: 'correct horse battery' } });
  assert.equal(result.status, 500);
  assert.deepEqual(result.body, { error: { code: 'INTERNAL_ERROR' } });
});
async function fixture(t) {
  const user = await db.user.create({ data: { name: 'Auth Test', username: 't_' + randomUUID(), passwordHash: await hashPassword('correct horse battery'), role: 'CASHIER' } });
  t.after(() => db.user.delete({ where: { id: user.id } }));
  return user;
}

test('refresh rotates digests and replay commits session revocation', async t => {
  const user = await fixture(t);
  const first = await createSession(db, user.id);
  assert.equal(await db.refreshToken.findUnique({ where: { digest: first.refreshToken } }), null);
  const next = await rotateSession(db, first.refreshToken);
  assert.equal(next.session.id, first.session.id);
  assert.equal(next.session.expiresAt.getTime(), first.session.expiresAt.getTime());
  assert.notEqual(next.refreshToken, first.refreshToken);
  assert.ok((await db.refreshToken.findUnique({ where: { digest: digestToken(first.refreshToken) } })).consumedAt);
  assert.equal(await rotateSession(db, first.refreshToken), null);
  assert.ok((await db.authSession.findUnique({ where: { id: first.session.id } })).revokedAt);
  assert.equal(await rotateSession(db, next.refreshToken), null);
});

test('expiry, inactive user and logout reject refresh; unknown logout idempotent', async t => {
  const user = await fixture(t);
  const old = await createSession(db, user.id, new Date(Date.now() - 31 * 86400000));
  assert.equal(await rotateSession(db, old.refreshToken), null);
  const disabled = await createSession(db, user.id);
  await db.user.update({ where: { id: user.id }, data: { isActive: false } });
  assert.equal(await rotateSession(db, disabled.refreshToken), null);
  await db.user.update({ where: { id: user.id }, data: { isActive: true } });
  const live = await createSession(db, user.id);
  await revokeSession(db, live.refreshToken);
  await revokeSession(db, live.refreshToken);
  await revokeSession(db, 'x'.repeat(43));
  assert.equal(await rotateSession(db, live.refreshToken), null);
});

test('parallel refresh serializes and loser revokes winner session', { timeout: 15000 }, async t => {
  const user = await fixture(t);
  const first = await createSession(db, user.id);
  const held = barrier(), release = barrier();
  const wrapped = { ...db, $transaction: (callback, options) => db.$transaction(async tx => {
    const result = await callback(tx);
    held.resolve();
    await release.promise;
    return result;
  }, options) };
  let winner;
  try {
    const a = rotateSession(wrapped, first.refreshToken);
    await held.promise;
    const b = rotateSession(db, first.refreshToken);
    release.resolve();
    [winner] = await Promise.all([a, b.then(result => assert.equal(result, null))]);
  } finally { release.resolve(); }
  assert.ok(winner);
  assert.ok((await db.authSession.findUnique({ where: { id: first.session.id } })).revokedAt);
});

test('failed rotation insert rolls back consumption', async t => {
  const user = await fixture(t);
  const first = await createSession(db, user.id);
  const wrapped = { ...db, $transaction: (callback, options) => db.$transaction(tx => callback(new Proxy(tx, { get(target, key) {
    if (key === 'refreshToken') return { ...target.refreshToken, create: () => { throw new Error('injected insertion failure'); } };
    return target[key];
  } })), options) };
  await assert.rejects(rotateSession(wrapped, first.refreshToken), /injected insertion failure/);
  assert.ok(await rotateSession(db, first.refreshToken));
});

test('logout waits for refresh commit and revokes rotated token', { timeout: 15000 }, async t => {
  const user = await fixture(t);
  const first = await createSession(db, user.id);
  const held = barrier(), release = barrier();
  const wrapped = { ...db, $transaction: (callback, options) => db.$transaction(async tx => {
    const result = await callback(tx); held.resolve(); await release.promise; return result;
  }, options) };
  try {
    const a = rotateSession(wrapped, first.refreshToken);
    await held.promise;
    const b = revokeSession(db, first.refreshToken);
    release.resolve();
    const [next] = await Promise.all([a, b]);
    assert.equal(await rotateSession(db, next.refreshToken), null);
  } finally { release.resolve(); }
});
