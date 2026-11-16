# OpenCafe backend

Express 5 + Prisma 7 / MySQL-protocol database. Authentication supports `ADMIN` and `CASHIER`.

## Setup

Requires Node.js 22.18+ and MySQL/MariaDB. Verified with Node 22.23.4 and MariaDB 12.3.3; MySQL-specific compatibility has not been exercised.

1. Run `npm ci` and copy `.env.example` to `.env` with owner-only permissions (`chmod 600 .env`). Set `DATABASE_URL`, `APP_ORIGIN`, and a random `JWT_SECRET` of at least 32 bytes without whitespace/control characters. Never commit `.env`.
2. Run `npm run prisma:validate` and `npm run prisma:generate`.
3. For a **new, empty database only**, run `npm run prisma:migrate`. This applies the existing POS schema baseline followed by authentication tables. It does not create the database.
4. Create the first admin with `npm run admin:create < /private/path/admin.json`. The input file must be owner-readable only and contain exactly `name`, `username`, and `password`. Use your own values; password must contain 12–128 Unicode characters (maximum 512 UTF-8 bytes), with no control characters. Remove the private file after successful setup. Do not put passwords in command arguments, shell history, or logs. The command refuses once any ADMIN exists; concurrent invocations create at most one admin.
5. Run `npm start`. The process connects to the database before listening and closes gracefully on SIGTERM/SIGINT.

**Existing databases:** Do not run the baseline blindly. Back up first. Compare the existing schema with `prisma/migrations/202611170001_baseline/migration.sql`; reconcile differences before an operator records the baseline with `npx prisma migrate resolve --applied 202611170001_baseline`. Only then deploy the auth migration. No populated-upgrade rehearsal was performed. Never reset or drop a populated schema to make migration commands pass.

`DATABASE_URL` is the single runtime/migration connection source. Reserved credential characters must be percent-encoded. Query options are rejected rather than silently ignored. Production should use a least-privilege DB account, not root. This adapter setup supports private-network DB connections; it does not configure database TLS. Configure TLS support before using an untrusted DB network.

`APP_ORIGIN` must be an exact origin without a trailing slash/path, such as `https://pos.example.com`. Set `NODE_ENV=production` for Secure cookies; production requires an HTTPS origin. Serve client and API from the same origin (for example reverse-proxy `/api` to this server). No cross-origin CORS permission is enabled. `SameSite=Strict` does not support cross-site frontend hosting.

## Layout

- `src/controllers`: HTTP auth handlers.
- `src/middlewares`: authentication, role checks, CSRF, throttling, safe errors.
- `src/routes`: endpoint wiring and protection.
- `src/utils`: password/JWT/input/config and transactional session helpers.
- `src/configs`: real Prisma adapter.
- `src/scripts`: first-admin bootstrap.
- `src/app.js`: injectable Express application; `src/server.js`: runtime entrypoint.

## Authentication API

All paths start with `/api/auth`. Responses use `Cache-Control: no-store`. Errors are `{ "error": { "code": "..." } }` without internal database details.

| Method | Path | Access | Request | Response |
| --- | --- | --- | --- | --- |
| POST | `/register` | Current active ADMIN bearer | `name`, `username`, `password`, `role` (`ADMIN` or `CASHIER`, required) | 201 `{user}` |
| POST | `/login` | Public, custom header below | `username`, `password` | 200 `{accessToken, expiresIn:900, user}` and refresh cookie |
| POST | `/refresh` | Refresh cookie, custom header below | No body required | 200 new access token + rotated cookie |
| POST | `/logout` | Refresh cookie, custom header below | No body required | 204, revoke session and clear cookie; missing/unknown cookie is idempotent |
| GET | `/me` | Current active ADMIN or CASHIER bearer | None | 200 `{user}` |

JSON input only, 8 KiB limit. Reject unknown fields. Usernames are normalized to lowercase, 3–100 ASCII letters/digits/`_`/`.`/`-`; names are trimmed, 1–100 characters. Passwords are never trimmed. Returned user contains only `id`, `name`, `username`, `role`, `isActive`.

Bearer format: `Authorization: Bearer <accessToken>`. No access JWT in cookies or URLs. Missing/invalid/expired credentials return 401; wrong role 403; input errors 400; duplicate username 409; rate/capacity limits 429; unexpected failure 500.

`/login`, `/refresh`, `/logout` require `X-Requested-With: XMLHttpRequest`. If `Origin` is present it must exactly match `APP_ORIGIN`; `null` and foreign origins return 403. Native callers may omit Origin but must send the custom header. Browser clients must send credentials. Never add permissive CORS middleware around these routes.

## Client renewal

Keep the access JWT in memory, not localStorage. The browser manages the HttpOnly `opencafe_refresh` cookie; it is SameSite=Strict, Secure in production, scoped to `/api/auth`. Do not expose the refresh secret in JSON or JavaScript.

```js
let accessToken;
let refreshInFlight;

export async function login(username, password) {
  const response = await fetch('/api/auth/login', {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) throw new Error('Login failed');
  const result = await response.json();
  accessToken = result.accessToken;
  return result.user;
}

async function refresh() {
  refreshInFlight ??= (async () => {
    const response = await fetch('/api/auth/refresh', {
      method: 'POST', credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
    if (!response.ok) { accessToken = undefined; throw new Error('Login required'); }
    accessToken = (await response.json()).accessToken;
  })().finally(() => { refreshInFlight = undefined; });
  await refreshInFlight;
}

export async function api(path, options = {}) {
  if (!accessToken) await refresh(); // Also restores access after page reload.
  const send = () => {
    const headers = new Headers(options.headers);
    headers.set('Authorization', `Bearer ${accessToken}`);
    return fetch(path, { ...options, headers });
  };
  const response = await send();
  if (response.status !== 401) return response;
  await refresh();
  return send(); // At most one retry. Use replayable bodies, not consumed streams.
}
```

Access JWTs last 15 minutes. Refresh sessions have a **fixed 30-day deadline** from login; renewal does not extend it. Each refresh consumes the old secret and creates a new one transactionally. Reuse of any consumed secret revokes the whole session, including already-issued access JWTs. A lost refresh response can therefore require login again; never retry an old refresh cookie deliberately.

Serialize refresh across **all tabs** sharing the cookie, not just requests in one tab. The example provides single-flight protection within one JS context; coordinate multiple tabs with the Web Locks API/BroadcastChannel before supporting that workflow. Concurrent refresh requests intentionally fail closed on replay.

Logout uses POST with the same custom header and `credentials: 'include'`; clear the in-memory access JWT after it succeeds. Every protected request rechecks DB session expiry/revocation and current account activity/role, rather than trusting a stale JWT role. Disabling an account blocks access and refresh; a refresh attempt while disabled revokes that session. Merely re-enabling without such an attempt can restore otherwise-valid sessions. Password reset/global session management are out of scope.

## Security and operation limits

- Passwords use salted asynchronous scrypt (`N=16384`, `r=8`, `p=1`, 64-byte key), timing-safe comparison, and a versioned stored format. At most four simultaneous hash operations per process; overflow returns 429.
- Login limits: 10 attempts per normalized username and 50 per client IP per 15 minutes. At most 10,000 limiter keys; saturation rejects new admission. Limits count successful attempts too. Store is in memory: restarts reset it. Use a shared limiter store before multiple server instances.
- Express does not trust forwarded IP headers. Behind a proxy all clients otherwise share the proxy IP limit; configure only explicitly trusted proxy hops before production and test spoofed headers. Never set `trust proxy` indiscriminately.
- Terminate HTTPS at a trusted proxy; keep backend and database on private networks. Redact Authorization, cookies, request bodies and auth response bodies in proxy/APM logs. No application credential logging is installed.
- Consumed refresh-token digests must remain until their session expires, or replay detection is lost. Run this maintenance query periodically using a trusted DB tool: `DELETE FROM auth_sessions WHERE expires_at < UTC_TIMESTAMP(3);`. Token rows cascade-delete. Do not delete token history for unexpired sessions.
- Existing POS schema's invalid multiline relation syntax was normalized; `Order.payment` became `payments` because payment attempts are one-to-many. No other business API is included.

## Verification

```sh
npm test
npm run prisma:validate
npm run prisma:generate
```

Offline suite tests crypto, JWT validation, configuration, input boundaries, CSRF, cookie parsing, limiter capacity/recovery, and bootstrap input safety.

Live suite requires **explicit authorization to create and delete fixtures** in the selected test database. Set `TEST_DATABASE_URL` and `TEST_DATABASE_ACK=host:port/schema` to exactly identify it, then run:

```sh
npm run test:integration
npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code
```

The suite does not migrate/reset/drop schemas. Apply migrations separately to an authorized empty test DB. It cleans only fixture-owned users (sessions/tokens cascade). Bootstrap race test requires no ADMIN and refuses otherwise; never delete real accounts to satisfy it. Do not run this suite against production. Missing test configuration fails, not skips. Drift command uses `DATABASE_URL`, so select that target deliberately too.

Live checks include mounted admin/cashier permissions, current role/activity, refresh replay/logout/expiry, generic credential failures, CSRF/cookie behavior, throttle/error safety, real transaction races and rollback, first-admin concurrent subprocesses/UTF-8 password integrity, generated-client runtime startup and graceful shutdown.
