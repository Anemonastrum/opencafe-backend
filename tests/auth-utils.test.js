import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/utils/config.js';
import { hashPassword, verifyPassword, signAccess, verifyAccess, newRefreshToken, digestToken } from '../src/utils/auth.js';
import { parseRegister, parseLogin } from '../src/utils/validation.js';

const env = { JWT_SECRET: 's'.repeat(48), APP_ORIGIN: 'http://localhost:3000' };
const config = loadConfig(env);

test('scrypt verifies exact UTF-8 passwords, salts hashes and rejects malformed storage', async () => {
  const password = '  mật khẩu 猫 long  ';
  const hash = await hashPassword(password);
  assert.notEqual(hash, await hashPassword(password));
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword(password.trim(), hash), false);
  for (const bad of ['', 'scrypt$9999999999$bad', hash + '00']) assert.equal(await verifyPassword(password, bad), false);
});

test('password work rejects overflow and recovers capacity', async () => {
  const pending = Array.from({ length: 4 }, () => hashPassword('correct horse battery'));
  await assert.rejects(hashPassword('correct horse battery'), { status: 429 });
  await Promise.all(pending);
  assert.equal(await verifyPassword('correct horse battery', await hashPassword('correct horse battery')), true);
});

test('access tokens enforce signature, expiry, issuer, audience and session identity', () => {
  const token = signAccess(12, 'ec159ee4-0a00-4b01-bc43-2b8fffc6edf7', config);
  assert.equal(verifyAccess(token, config).sub, '12');
  for (const bad of [token + 'x', '', 'abc']) assert.throws(() => verifyAccess(bad, config));
  for (const changed of [{ jwtSecret: 'z'.repeat(48) }, { issuer: 'else' }, { audience: 'else' }]) {
    assert.throws(() => verifyAccess(token, { ...config, ...changed }));
  }
  assert.throws(() => verifyAccess(signAccess(12, 'ec159ee4-0a00-4b01-bc43-2b8fffc6edf7', { ...config, accessSeconds: -1 }), config));
  const raw = newRefreshToken();
  assert.match(raw, /^[A-Za-z0-9_-]{43}$/);
  assert.match(digestToken(raw), /^[a-f0-9]{64}$/);
  assert.notEqual(raw, newRefreshToken());
});

test('configuration fails closed for secret and origin problems', () => {
  for (const JWT_SECRET of ['', 'short', ' '.repeat(48), 's'.repeat(48) + '\n']) assert.throws(() => loadConfig({ ...env, JWT_SECRET }));
  for (const APP_ORIGIN of ['null', 'not-url', 'https://site.test/path', 'https://user:pw@site.test', 'https://site.test/']) assert.throws(() => loadConfig({ ...env, APP_ORIGIN }));
  assert.throws(() => loadConfig({ ...env, NODE_ENV: 'production' }));
  assert.equal(loadConfig({ ...env, NODE_ENV: 'production', APP_ORIGIN: 'https://pos.test' }).production, true);
  assert.throws(() => loadConfig({ ...env, PORT: 'abc' }));
});

test('input validation enforces role, fields and boundaries without trimming passwords', () => {
  const input = { name: ' Cafe Admin ', username: 'Admin_1', password: '  password 12  ', role: 'ADMIN' };
  assert.deepEqual(parseRegister(input), { ...input, name: 'Cafe Admin', username: 'admin_1' });
  assert.deepEqual(parseLogin({ username: 'Admin_1', password: input.password }), { username: 'admin_1', password: input.password });
  for (const body of [null, [], {}, { ...input, role: 'admin' }, { ...input, isActive: true }, { ...input, password: 'short' }, { ...input, username: 'bad name' }, { ...input, name: ' '.repeat(5) }, { ...input, password: 'x'.repeat(129) }, { ...input, name: 'x'.repeat(101) }]) assert.throws(() => parseRegister(body), { status: 400 });
  assert.throws(() => parseLogin({ username: 'admin', password: 123 }), { status: 400 });
});
