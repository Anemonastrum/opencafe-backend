import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../src/app.js';
import { prisma } from '../src/configs/prisma.js';

test('mounted cafe settings CRUD stays simple and handles validation/errors', async t => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await prisma.$disconnect(); });
  const request = async (method, body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/cafe-settings`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json() };
  };
  // Prisma delegate uses proxy descriptors; replace method at DB boundary directly.
  const mockMethod = (name, implementation) => {
    const original = prisma.cafeSetting[name];
    const mock = t.mock.fn(implementation);
    prisma.cafeSetting[name] = mock;
    t.after(() => { prisma.cafeSetting[name] = original; });
    return mock;
  };
  const record = { id: 1, name: 'Cafe', address: 'Main Street', logoUrl: null, taxEnabled: false, taxName: 'PBJT', taxRate: '10', taxInclusive: false };
  const find = mockMethod('findUnique', async args => { assert.deepEqual(args, { where: { id: 1 } }); return null; });
  assert.equal((await request('GET')).status, 404);
  find.mock.mockImplementation(async () => record);
  assert.deepEqual((await request('GET')).body, record);
  const create = mockMethod('create', async args => { assert.deepEqual(args, { data: { id: 1, name: 'Cafe', address: 'Main Street' } }); return record; });
  assert.deepEqual(await request('POST', { name: ' Cafe ', address: 'Main Street' }), { status: 201, body: { message: 'ok', cafeSetting: record } });
  create.mock.mockImplementation(async () => { throw Object.assign(new Error('private'), { code: 'P2002' }); });
  assert.equal((await request('POST', { name: 'Cafe', address: 'Main Street' })).status, 409);
  mockMethod('update', async args => { assert.deepEqual(args, { where: { id: 1 }, data: { taxEnabled: false, taxRate: '0', logoUrl: null } }); return { ...record, taxRate: '0' }; });
  assert.equal((await request('PUT', { taxEnabled: false, taxRate: 0, logoUrl: null })).body.cafeSetting.taxRate, '0');
  for (const method of ['POST', 'PUT']) assert.equal((await request(method, { id: 2 })).status, 400);
  const remove = mockMethod('delete', async args => { assert.deepEqual(args, { where: { id: 1 } }); return record; });
  assert.deepEqual(await request('DELETE'), { status: 200, body: { message: 'ok' } });
  remove.mock.mockImplementation(async () => { throw Object.assign(new Error('private'), { code: 'P2025' }); });
  assert.equal((await request('DELETE')).status, 404);
  find.mock.mockImplementation(async () => { throw new Error('private DB credentials'); });
  assert.deepEqual(await request('GET'), { status: 500, body: { message: 'server error' } });
});
