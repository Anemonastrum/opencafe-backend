import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

export function cli(input, args = [], extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/scripts/create-admin.js', ...args], { env });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.on('error', () => {});
  const finished = new Promise(resolve => child.once('close', code => resolve({ code, stdout, stderr })));
  if (Array.isArray(input)) {
    child.stdin.write(input[0], () => setTimeout(() => child.stdin.end(input[1]), 20));
  } else child.stdin.end(input);
  return finished;
}
test('bootstrap rejects invalid UTF-8 bytes before database or password changes', async () => {
  const bytes = Buffer.concat([Buffer.from('{"name":"Admin","username":"admin","password":"long password '), Buffer.from([0xff]), Buffer.from('"}')]);
  const result = await cli(bytes, [], { DATABASE_URL: 'not-a-url' });
  assert.equal(result.code, 1);
  assert.equal(result.stderr.trim(), 'INVALID_UTF8');
});

test('bootstrap rejects args, malformed or oversized stdin without exposing secrets', async () => {
  const secret = 'sensitive-password-value';
  for (const [input, args] of [['{}', [secret]], ['{bad', []], ['x'.repeat(9000), []], [JSON.stringify({ name: 'Admin', username: 'admin', password: secret, role: 'CASHIER' }), []]]) {
    const result = await cli(input, args);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.includes(secret), false);
    assert.match(result.stderr, /ADMIN_SETUP_FAILED/);
  }
});
