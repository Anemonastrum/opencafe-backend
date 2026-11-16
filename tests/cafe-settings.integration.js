import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../src/app.js';
import { prisma } from '../src/configs/prisma.js';

// writes stay inside a rolled-back transaction; never overwrite existing settings
 test('real database cafe settings CRUD rolls back every fixture change', async t => {
  const target = `${process.env.DATABASE_HOST}:${process.env.DATABASE_PORT || 3306}/${process.env.DATABASE_NAME}`;
  assert.equal(process.env.CAFE_TEST_DATABASE_ACK, target, 'Set CAFE_TEST_DATABASE_ACK=host:port/database for authorized tests');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await prisma.$disconnect(); });
  const request = async (method, body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/cafe-settings`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json() };
  };
  const rollback = new Error('rollback test fixtures');
  await assert.rejects(prisma.$transaction(async tx => {
    assert.equal(await tx.cafeSetting.count(), 0, 'Existing cafe settings found; test refuses to modify them');
    const originals = {};
    for (const method of ['findUnique', 'create', 'update', 'delete']) {
      originals[method] = prisma.cafeSetting[method];
      prisma.cafeSetting[method] = args => tx.cafeSetting[method](args);
    }
    try {
      assert.equal((await request('GET')).status, 404);
      const created = await request('POST', { name: 'Test Cafe', address: 'Test Street' });
      assert.equal(created.status, 201);
      assert.equal(created.body.cafeSetting.id, 1);
      assert.equal(created.body.cafeSetting.taxName, 'PBJT');
      assert.equal(created.body.cafeSetting.taxEnabled, false);
      assert.equal((await request('POST', { name: 'Other', address: 'Other' })).status, 409);
      const updated = await request('PUT', { taxRate: '12.25', taxEnabled: true });
      assert.equal(updated.status, 200);
      assert.equal(updated.body.cafeSetting.taxRate, '12.25');
      assert.equal(updated.body.cafeSetting.name, 'Test Cafe');
      assert.equal((await request('GET')).body.taxRate, '12.25');
      assert.equal((await request('DELETE')).status, 200);
      assert.equal((await request('GET')).status, 404);
      assert.equal((await request('PUT', { name: 'Missing' })).status, 404);
      assert.equal((await request('DELETE')).status, 404);
    } finally {
      for (const method of Object.keys(originals)) prisma.cafeSetting[method] = originals[method];
    }
    throw rollback;
  }, { timeout: 15000 }), error => error === rollback);
  assert.equal(await prisma.cafeSetting.count(), 0);
});
