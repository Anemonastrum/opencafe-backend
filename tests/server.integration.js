import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import 'dotenv/config';
import { testDatabase } from './db-helper.js';

test('real server starts with generated Prisma client and stops gracefully', { timeout: 15000 }, async () => {
  const db = testDatabase(); // Validates explicit test target before subprocess.
  await db.$disconnect();
  const env = { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL, PORT: '0', JWT_SECRET: 't'.repeat(48), APP_ORIGIN: 'http://localhost:3000' };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  try {
    const port = await new Promise((resolve, reject) => {
      child.stdout.on('data', chunk => { const match = chunk.toString().match(/Listening on port (\d+)/); if (match) resolve(Number(match[1])); });
      child.once('exit', code => reject(new Error('Server exited before ready: ' + code + ' ' + errors)));
    });
    const response = await fetch(`http://127.0.0.1:${port}/api/auth/me`);
    assert.equal(response.status, 401);
    const exited = once(child, 'exit'); child.kill('SIGTERM');
    assert.equal((await exited)[0], 0);
    assert.equal(errors, '');
  } finally { child.kill('SIGKILL'); }
});
