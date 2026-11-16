import test from 'node:test';
import assert from 'node:assert/strict';
import { loginLimiter, csrf, refreshCookie } from '../src/middlewares/security.js';

function check(middleware, req) {
  let error; middleware(req, { set() {} }, e => { error = e; }); return error;
}
test('login limiter bounds username, IP, store capacity and recovers after expiry', () => {
  let now = 0;
  const limiter = loginLimiter({ clock: () => now });
  const req = (ip, username) => ({ ip, body: { username } });
  for (let i = 0; i < 10; i++) assert.equal(check(limiter, req('ip'+i, 'Same')), undefined);
  assert.equal(check(limiter, req('other', 'same')).status, 429);
  for (let i = 0; i < 50; i++) assert.equal(check(limiter, req('shared', 'user'+i)), undefined);
  assert.equal(check(limiter, req('shared', 'newuser')).status, 429);
  now = 900001;
  assert.equal(check(limiter, req('shared', 'same')), undefined);
  const small = loginLimiter({ maxKeys: 2, clock: () => now });
  assert.equal(check(small, req('one', 'one')), undefined);
  assert.equal(check(small, req('two', 'two')).status, 429);
  now += 900001;
  assert.equal(check(small, req('two', 'two')), undefined);
});
test('CSRF requires custom header and exact trusted Origin', () => {
  const guard = csrf({ appOrigin: 'https://pos.test' });
  const req = headers => ({ get: key => headers[key.toLowerCase()] });
  assert.equal(check(guard, req({ 'x-requested-with': 'XMLHttpRequest' })), undefined);
  assert.equal(check(guard, req({ 'x-requested-with': 'XMLHttpRequest', origin: 'https://pos.test' })), undefined);
  for (const headers of [{}, { 'x-requested-with': 'XMLHttpRequest', origin: 'null' }, { 'x-requested-with': 'XMLHttpRequest', origin: 'https://evil.test' }]) assert.equal(check(guard, req(headers)).status, 403);
});
test('refresh cookie parser rejects duplicates and malformed credentials', () => {
  const value = 'A'.repeat(43);
  assert.equal(refreshCookie({ headers: { cookie: 'opencafe_refresh='+value } }), value);
  for (const cookie of ['opencafe_refresh=x', 'opencafe_refresh=%zz', 'opencafe_refresh='+value+'; opencafe_refresh='+value]) assert.equal(refreshCookie({ headers: { cookie } }), null);
});
