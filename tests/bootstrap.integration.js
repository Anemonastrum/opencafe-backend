import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { testDatabase } from './db-helper.js';
import { verifyPassword } from '../src/utils/auth.js';

const db = testDatabase();
test.after(() => db.$disconnect());
function run(input) {
  const env = { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/scripts/create-admin.js'], { env });
  let stdout = '', stderr = '';
  child.stdout.on('data', c => { stdout += c; });
  child.stderr.on('data', c => { stderr += c; });
  child.stdin.on('error', () => {});
  const finished = new Promise(resolve => child.once('close', code => resolve({ code, stdout, stderr })));
  const bytes = Buffer.from(JSON.stringify(input));
  const split = bytes.indexOf(Buffer.from('猫')) + 1;
  child.stdin.write(bytes.subarray(0, split), () => setTimeout(() => child.stdin.end(bytes.subarray(split)), 30));
  return finished;
}
test('parallel first-admin CLIs create exactly one admin and preserve split UTF-8 password', { timeout: 20000 }, async t => {
  assert.equal(await db.user.count({ where: { role: 'ADMIN' } }), 0, 'Bootstrap fixture requires no existing ADMIN; never remove existing users');
  const names = ['a_' + randomUUID(), 'b_' + randomUUID()];
  t.after(() => db.user.deleteMany({ where: { username: { in: names } } }));
  const password = 'password 猫 multibyte';
  const results = await Promise.all(names.map(username => run({ name: 'Bootstrap Test', username, password })));
  assert.equal(results.filter(r => r.code === 0).length, 1, JSON.stringify(results));
  assert.equal(await db.user.count({ where: { role: 'ADMIN' } }), 1);
  const user = await db.user.findFirst({ where: { username: { in: names } } });
  assert.equal(await verifyPassword(password, user.passwordHash), true);
  for (const result of results) assert.equal((result.stdout + result.stderr).includes(password), false);
  const refused = await run({ name: 'Bootstrap Test', username: names.find(n => n !== user.username), password });
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /ADMIN_ALREADY_EXISTS/);
});
