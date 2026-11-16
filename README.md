# OpenCafe backend

Simple cafe settings CRUD using Express and Prisma. Auth middleware comes later. Server binds to `127.0.0.1` by default; do not expose these unprotected routes publicly.

## Run

1. Run `npm ci`.
2. Copy `.env.example` to `.env`, then fill database connection values. Prisma CLI uses `DATABASE_URL`; runtime uses `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_USER`, `DATABASE_PASSWORD`, `DATABASE_NAME`. Both must point to the same database.
3. Run `npx prisma generate`. Database tables must already match `prisma/schema.prisma`; no migrations are included or run by the app.
4. Run `npm start`. Default: `http://127.0.0.1:3000`. `PORT` changes port; `HOST` changes bind address.

## Cafe settings

One cafe, one record (`id: 1`). JSON requests only. `logoUrl` stores an HTTP(S) URL, not an uploaded file.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/cafe-settings` | Create; returns 201, duplicate returns 409 |
| GET | `/api/cafe-settings` | Read; returns record directly |
| PUT | `/api/cafe-settings` | Update only supplied fields |
| DELETE | `/api/cafe-settings` | Delete |

Create body:

```json
{
  "name": "OpenCafe",
  "address": "Main Street",
  "logoUrl": null,
  "taxEnabled": false,
  "taxName": "PBJT",
  "taxRate": "10.00",
  "taxInclusive": false
}
```

Only `name` and `address` required on create. Optional fields use Prisma defaults. Tax rate: 0–100, maximum two decimal places; accept JSON number or decimal string. Booleans must be JSON booleans. Set `logoUrl` to `null` to clear it. Unknown fields and empty updates return 400. Missing settings return 404. Unexpected errors return safe `{ "message": "server error" }` without DB details.

Create/update return `{ "message": "ok", "cafeSetting": { ... } }`; delete returns `{ "message": "ok" }`. Decimal tax rates serialize as strings.

Code: `src/controllers/cafeSetting.js`, `src/routes/cafeSetting.js`, `src/utils/cafeSettingValidation.js`. Controllers call Prisma directly; no extra service/model layers.

## Test

```sh
npm test
npx prisma validate
```

Offline tests use a DB-boundary stub and exercise mounted routes. Real DB test uses a rolled-back transaction, refuses existing cafe settings, and requires explicit target acknowledgement:

```sh
CAFE_TEST_DATABASE_ACK=host:port/database node --import tsx --test tests/cafe-settings.integration.js
```

Use only an authorized test database. No reset, migration, or committed fixture changes. Verified on MariaDB 12.3.3; MySQL-specific behavior not tested.
