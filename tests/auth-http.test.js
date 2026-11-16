import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/utils/config.js';

const config = loadConfig({ JWT_SECRET: 't'.repeat(48), APP_ORIGIN: 'https://pos.test', NODE_ENV: 'production' });

test('mounted boundary rejects cookies without CSRF, foreign preflight and non-JSON without DB calls', async t => {
  const app = createApp({ prisma: {}, config });
  assert.equal(app.get('trust proxy'), false);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/auth`;
  for (const path of ['/login', '/refresh', '/logout']) {
    const response = await fetch(base + path, { method: 'POST' });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  const preflight = await fetch(base + '/refresh', { method: 'OPTIONS', headers: { Origin: 'https://evil.test', 'Access-Control-Request-Headers': 'X-Requested-With' } });
  assert.equal(preflight.headers.get('access-control-allow-origin'), null);
  assert.equal(preflight.headers.get('access-control-allow-headers'), null);
  const badType = await fetch(base + '/login', { method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-Requested-With': 'XMLHttpRequest' }, body: '{"username":"admin","password":"correct horse battery"}' });
  assert.equal(badType.status, 400);
  assert.equal(badType.headers.get('x-powered-by'), null);
  const malformed = Buffer.concat([Buffer.from('{"username":"admin","password":"correct horse battery'), Buffer.from([0xff]), Buffer.from('"}')]);
  const badBytes = await fetch(base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: malformed });
  assert.equal(badBytes.status, 400);
  assert.deepEqual(await badBytes.json(), { error: { code: 'INVALID_UTF8' } });
  const loneSurrogate = await fetch(base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify({ username: 'admin', password: 'correct horse battery' + String.fromCharCode(0xd800) }) });
  assert.equal(loneSurrogate.status, 400);
  const anonymous = await fetch(base + '/me?accessToken=fake', { headers: { Cookie: 'accessToken=fake' } });
  assert.equal(anonymous.status, 401);
});
