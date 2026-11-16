import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { testDatabase, barrier } from './db-helper.js';
import { createSession, rotateSession, revokeSession, createFirstAdmin } from '../src/utils/sessions.js';
import { digestToken, hashPassword } from '../src/utils/auth.js';

const db = testDatabase();
test.after(() => db.$disconnect());
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
