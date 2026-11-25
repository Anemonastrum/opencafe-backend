import 'dotenv/config';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

export const setupLockName = database => createHash('sha256').update('opencafe:admin-setup:' + database).digest('hex');
import mariadb from 'mariadb';
import { hashPassword } from './utils/auth.utils.js';
import { passwordValid } from './utils/user.utils.js';

export const initialAdminPassword = (env = process.env) => {
  const password = env.ADMIN_PASSWORD || 'AdminPassword123';
  if (!passwordValid(password)) throw new Error('ADMIN_PASSWORD must contain 8–128 UTF-8 bytes');
  return password;
};

export const bootstrapAdmin = async (db, password, { legacyHash } = {}) => {
  const admins = await db.query("SELECT id,username,password_hash FROM users WHERE role='ADMIN'");
  if (admins.length && !(legacyHash && admins.length === 1 && admins[0].username === 'admin' && admins[0].password_hash === legacyHash)) return 'preserved';
  const hash = await hashPassword(password);
  if (admins.length) {
    const result = await db.query("UPDATE users SET password_hash=?,updated_at=CURRENT_TIMESTAMP(3) WHERE id=? AND role='ADMIN' AND username='admin' AND password_hash=?", [hash, admins[0].id, legacyHash]);
    if (result.affectedRows !== 1) throw new Error('Administrator changed during setup; no password overwritten');
    return 'initialized';
  }
  await db.query("INSERT INTO users (name,username,password_hash,role,is_active,updated_at) VALUES ('Administrator','admin',?,'ADMIN',true,CURRENT_TIMESTAMP(3))", [hash]);
  return 'created';
};

const migrate = () => new Promise((resolve, reject) => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const child = spawn('./node_modules/.bin/prisma', ['migrate', 'deploy'], { env, stdio: 'inherit' });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolve() : reject(new Error('Migration failed')));
});

const setup = async () => {
  const password = initialAdminPassword();
  const url = new URL(process.env.DATABASE_URL);
  // CLI and application must operate on exactly the same datasource.
  assert.ok(url.protocol === 'mysql:' && !url.search && !url.hash);
  assert.equal(url.hostname, process.env.DATABASE_HOST);
  assert.equal(Number(url.port || 3306), Number(process.env.DATABASE_PORT || 3306));
  assert.equal(decodeURIComponent(url.pathname.slice(1)), process.env.DATABASE_NAME);
  assert.equal(decodeURIComponent(url.username), process.env.DATABASE_USER);
  assert.equal(decodeURIComponent(url.password), process.env.DATABASE_PASSWORD);
  const db = await mariadb.createConnection({ host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: process.env.DATABASE_NAME, connectTimeout: 5000 });
  const lock = setupLockName(process.env.DATABASE_NAME);
  try {
    const [locked] = await db.query('SELECT GET_LOCK(?,30) AS acquired', [lock]);
    if (locked.acquired !== 1) throw new Error('Setup already running');
    const [identity] = await db.query('SELECT DATABASE() AS name');
    assert.equal(identity.name, process.env.DATABASE_NAME);
    const tables = await db.query("SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('users','_prisma_migrations')");
    const names = new Set(tables.map(row => row.name));
    const admins = names.has('users') ? await db.query("SELECT id FROM users WHERE role='ADMIN'") : [];
    const applied = names.has('_prisma_migrations') ? await db.query("SELECT id FROM _prisma_migrations WHERE migration_name='202611170003_default_admin' AND finished_at IS NOT NULL AND rolled_back_at IS NULL") : [];
    // Only replace the legacy seed inserted by THIS invocation, never an existing admin.
    const sql = await readFile(new URL('../prisma/migrations/202611170003_default_admin/migration.sql', import.meta.url), 'utf8');
    const legacyHash = !admins.length && !applied.length ? sql.match(/'admin','([^']+)'/)[1] : undefined;
    await migrate();
    console.log('First administrator:', await bootstrapAdmin(db, password, { legacyHash }));
  } finally {
    await db.query('SELECT RELEASE_LOCK(?)', [lock]).catch(() => {});
    await db.end();
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  setup().catch(() => { console.error('Setup failed; check configuration, migrations and database access. Existing administrator passwords are not reset.'); process.exitCode = 1; });
}
