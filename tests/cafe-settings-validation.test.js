import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCafeSetting } from '../src/utils/cafeSettingValidation.js';

const input = { name: ' Cafe ', address: ' Main Street ' };
test('create requires name/address and preserves Prisma defaults', () => {
  assert.deepEqual(validateCafeSetting(input), { data: { name: 'Cafe', address: 'Main Street' } });
  for (const body of [null, [], {}, { name: 'Cafe' }, { ...input, id: 2 }, { ...input, name: ' ' }, { ...input, name: 'x'.repeat(151) }, { ...input, address: 'x'.repeat(65536) }]) assert.ok(validateCafeSetting(body).error);
});
test('update preserves omitted fields and accepts false, zero and null logo', () => {
  assert.deepEqual(validateCafeSetting({ taxEnabled: false, taxRate: 0, logoUrl: null }, true), { data: { taxEnabled: false, taxRate: '0', logoUrl: null } });
  assert.ok(validateCafeSetting({}, true).error);
  assert.deepEqual(validateCafeSetting({ taxRate: '10.25', taxName: ' PBJT ', taxInclusive: true }, true), { data: { taxRate: '10.25', taxName: 'PBJT', taxInclusive: true } });
});
test('reject invalid taxes, URLs and malformed text', () => {
  for (const body of [{ taxRate: -1 }, { taxRate: 100.01 }, { taxRate: '10.001' }, { taxRate: '1e1' }, { taxRate: null }, { taxRate: true }, { taxRate: '' }, { taxEnabled: 'false' }, { taxInclusive: 1 }, { taxName: '' }, { taxName: 'x'.repeat(51) }, { logoUrl: 'javascript:alert(1)' }, { logoUrl: 'invalid' }, { logoUrl: '' }, { name: String.fromCharCode(0xd800) }]) assert.ok(validateCafeSetting({ ...input, ...body }).error, JSON.stringify(body));
  assert.equal(validateCafeSetting({ ...input, logoUrl: 'https://example.com/logo.png', taxRate: 100 }).error, undefined);
});
