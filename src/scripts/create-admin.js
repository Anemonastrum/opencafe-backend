import 'dotenv/config';
import { isUtf8 } from 'node:buffer';
import { fail } from '../utils/errors.js';
import { createPrisma } from '../configs/prisma.js';
import { createFirstAdmin } from '../utils/sessions.js';
import { parseRegister } from '../utils/validation.js';

let prisma;
try {
  if (process.argv.length !== 2) throw new Error();
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += Buffer.byteLength(chunk);
    if (size > 8192) throw new Error();
    chunks.push(chunk);
  }
  const input = Buffer.concat(chunks);
  if (!isUtf8(input)) throw fail(400, 'INVALID_UTF8');
  const body = JSON.parse(input.toString('utf8'));
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['name', 'username', 'password'].includes(key))) throw new Error();
  parseRegister({ ...body, role: 'ADMIN' });
  prisma = createPrisma();
  const user = await createFirstAdmin(prisma, body);
  console.log(JSON.stringify({ user }));
} catch (error) {
  console.error(['ADMIN_ALREADY_EXISTS', 'INVALID_UTF8'].includes(error.code) ? error.code : 'ADMIN_SETUP_FAILED');
  process.exitCode = 1;
} finally {
  await prisma?.$disconnect();
}
