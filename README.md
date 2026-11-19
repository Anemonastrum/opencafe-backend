# OpenCafe Backend

Open-source cafe POS backend using Express 5, Prisma 7, MariaDB/MySQL, and JWT authentication.

## Implemented features

- Singleton cafe settings: cafe name, address, logo URL, and tax configuration.
- Product and category management with role-protected writes, pagination/search, product filters and image uploads.
- Product unavailability instead of deletion; referenced categories cannot be deleted.
- Pending orders with cashier ownership, captured prices/tax/receipt details, exact totals, item replacement and retained cancellation history.
- `ADMIN` and `CASHIER` roles with live database account, role, and session checks.
- Migration-seeded first administrator; administrator-only account registration.
- Salted scrypt password hashes; passwords and hashes never returned by the API.
- 15-minute JWT access tokens and database-backed, rotating refresh tokens.
- Fixed 30-day sessions, refresh replay detection, logout, and session revocation.
- Mandatory password change for bootstrap, newly registered, and password-reset accounts.
- Self-service profile and password updates for both roles.
- Multer image uploads converted to WebP with Sharp; server-generated `imageUrl` / `logoUrl` values.
- Dedicated public image listener on a port separate from the API.
- Administrator-only cashier listing, detail, profile/status editing, and password resets.
- Cashier deactivation and password reset revoke all target sessions. Reactivation does not restore them.
- Transactional user locking for authentication and account mutations, including concurrent login/refresh/reset/deactivation.
- Strict field allowlists, bounded pagination, JSON validation, and authentication rate limits.
- Graceful HTTP server shutdown and Prisma disconnection on `SIGINT`/`SIGTERM`.

Pending-order APIs, exact tax calculations, CASH checkout and native Midtrans Core API QRIS payments are implemented, including payment replay, signed notifications and protected status reconciliation. Successful payment completes its order atomically. Receipt rendering, refunds, payment force-release and background reconciliation are **not implemented**. Images are uploaded locally and served publicly; remote images are never fetched. No public registration, user deletion, administrator-management endpoints beyond registration, or session-listing endpoint exists.

## Setup

Requirements: Node.js 22 LTS (tested with 22.23.4), npm, Git, and an existing MariaDB/MySQL database. MariaDB 12.3.3 was used for integration checks.

1. Install dependencies and create local configuration:

   ```sh
   git clone https://github.com/Anemonastrum/opencafe-backend.git
   cd opencafe-backend
   npm ci
   cp .env.example .env
   ```

2. Fill in `.env`. `DATABASE_URL` is used by Prisma CLI; the separate `DATABASE_*` fields are used by the running API. Both must point to the same database. Percent-encode special characters in URL credentials.

   ```dotenv
   DATABASE_URL=mysql://opencafe:replace-with-db-password@127.0.0.1:3306/pos
   DATABASE_HOST=127.0.0.1
   DATABASE_PORT=3306
   DATABASE_USER=opencafe
   DATABASE_PASSWORD=replace-with-db-password
   DATABASE_NAME=pos
   PORT=3000
   HOST=127.0.0.1
   NODE_ENV=development
   JWT_SECRET=replace-with-generated-secret
   APP_ORIGIN=http://localhost:3000
   IMAGE_HOST=127.0.0.1
   IMAGE_PORT=3001
   IMAGE_BASE_URL=http://localhost:3001
   ```

   Generate `JWT_SECRET` with:

   ```sh
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

   The secret must contain at least 32 bytes without whitespace or controls. `APP_ORIGIN` must be an exact HTTP(S) origin without a trailing slash or path. In production, set `NODE_ENV=production`, use HTTPS, and supply an HTTPS `APP_ORIGIN`. Production refresh cookies require HTTPS. API binding follows `HOST` and `PORT`; `.env.example` uses loopback port 3000. Images use `IMAGE_HOST` and `IMAGE_PORT` (default loopback port 3001); ports must differ. `IMAGE_BASE_URL` is the public image-server origin used to generate stored URLs, for example `http://localhost:3001` or `https://images.example.com`. It must be an exact HTTP(S) origin without credentials, a path, query, fragment, or trailing slash; production requires HTTPS. Both listeners start with `npm start` and stop together. Route the image hostname to the image port, not the API port.

3. Back up any existing database before applying migrations. Apply the checked-in migrations, generate the client, and start the API:

   ```sh
   npx prisma migrate deploy
   npx prisma generate
   npm start
   ```

   Prisma reads `prisma7.config.ts`; generated client files live in ignored `src/generated/prisma/`. Do not edit applied migrations or use `migrate reset` on existing data.

### First administrator

Migration `202611170003_default_admin` inserts this account only if no `ADMIN` exists:

| Field | Initial value |
| --- | --- |
| Username | `admin` |
| Password | `ChangeMeBeforeUse!` |
| Role | `ADMIN` |
| `mustChangePassword` | `true` |

**This bootstrap password is public. Keep a new installation private until you change it through `PUT /api/auth/password`. Do not expose an installation that still uses this password.**

Existing administrators are not overwritten. A reserved `admin` username conflict fails instead of promoting that account. The password-change endpoint revokes all sessions, so sign in again afterward.

### Default cafe settings

Migration `202611170005_default_cafe_settings` inserts singleton settings (`id=1`) only when absent:

| Field | Initial value |
| --- | --- |
| Name | `OpenCafe` |
| Address | `OpenCafe Street` |
| Logo | `null` |
| Tax enabled | `false` |
| Tax name | `PBJT` |
| Tax rate | `10.00` |
| Tax inclusive | `false` |

Existing settings are not overwritten. Edit initial settings through `PUT /api/cafe`; `POST /api/cafe` returns `409` while settings already exist. This migration runs once, not on every server start.

## API conventions

- Local base URL: `http://localhost:3000`.
- Request/response fields use camelCase, including `imageUrl` and `isActive`.
- Send `Content-Type: application/json` for JSON bodies. Image-capable create/update endpoints also accept `multipart/form-data`; let the client generate its multipart boundary. Password/login endpoints remain JSON-only.
- JSON request limit: 80 KB. Unknown body fields are rejected by validators; updates must contain at least one allowed field.
- Protected endpoints use `Authorization: Bearer <accessToken>`.
- Except `/api/auth/me` and `/api/auth/password`, protected endpoints require `mustChangePassword=false`. Forced-change accounts can still log in, refresh, and log out. A blocked request returns `403` with `code: "PASSWORD_CHANGE_REQUIRED"`.
- User responses expose `id`, `name`, `username`, `role`, `mustChangePassword`, and `imageUrl`. Cashier-management responses also expose `isActive`. Password hashes and refresh tokens are never included in JSON responses.
- Authentication routes set `Cache-Control: no-store`.

### All available endpoints

`ADMIN*` / `Both*` mean the account must have completed its required password change. Every successful response below is JSON.

| Method | Path | Access | Input | Success |
| --- | --- | --- | --- | --- |
| POST | `/api/auth/login` | Public; origin check | `username`, `password` | `200` session response + refresh cookie |
| POST | `/api/auth/refresh` | Refresh cookie; origin check | No body required | `200` session response + rotated cookie |
| POST | `/api/auth/logout` | Origin check; cookie optional | No body required | `200` `{message}`; clears cookie |
| GET | `/api/auth/me` | Both | None | `200` `{user}` |
| PUT | `/api/auth/profile` | Both* | Partial `name`, `username`; optional file `image` or JSON `imageUrl: null` | `200` `{message, user}` |
| PUT | `/api/auth/password` | Both | `currentPassword`, `newPassword` | `200` `{message}`; sign in again |
| POST | `/api/admin/users` | ADMIN* | `name`, `username`, `password`; optional `role`, file `image` or JSON `imageUrl: null` | `201` `{message, user}` |
| GET | `/api/admin/cashiers` | ADMIN* | Optional query `page`, `limit` | `200` `{cashiers, page, limit, total}` |
| GET | `/api/admin/cashiers/:id` | ADMIN* | Positive cashier ID | `200` `{cashier}` |
| PUT | `/api/admin/cashiers/:id` | ADMIN* | Partial `name`, `username`, `isActive`; optional file `image` or JSON `imageUrl: null` | `200` `{message, cashier}` |
| PUT | `/api/admin/cashiers/:id/password` | ADMIN* | `newPassword` chosen by administrator | `200` `{message}` |
| GET | `/api/cafe` | Both* | None | `200` cafe settings object directly |
| POST | `/api/cafe` | ADMIN* | `name`, `address`; optional cafe fields and file `logo` | `201` `{message, cafeSetting}` |
| PUT | `/api/cafe` | ADMIN* | Partial cafe fields; optional file `logo` | `200` `{message, cafeSetting}` |
| DELETE | `/api/cafe` | ADMIN* | None | `200` `{message}` |
| GET | `/api/products` | Both* | Query `page`, `limit`, `search`, `categoryId`, `isAvailable` | `200` `{products, total, page, limit}` |
| GET | `/api/products/:id` | Both* | Positive product ID | `200` product object directly |
| POST | `/api/products` | ADMIN* | `name`, `price`; optional product fields/file `image` | `201` `{message, product}` |
| PUT | `/api/products/:id` | ADMIN* | Partial product fields/file `image` | `200` `{message, product}` |
| DELETE | `/api/products/:id` | ADMIN* | Positive product ID | `200` `{message, product}`; marks unavailable |
| GET | `/api/categories` | Both* | Query `page`, `limit`, `search` | `200` `{categories, total, page, limit}` |
| GET | `/api/categories/:id` | Both* | Positive category ID | `200` category object directly |
| POST | `/api/categories` | ADMIN* | JSON `name` | `201` `{message, category}` |
| PUT | `/api/categories/:id` | ADMIN* | JSON `name` | `200` `{message, category}` |
| DELETE | `/api/categories/:id` | ADMIN* | Positive category ID | `200` `{message}`; `409` if referenced |
| POST | `/api/orders` | Both*; actor owns new order | JSON `items` | `201` `{message, order}` |
| GET | `/api/orders` | Both*; owner scope | Query `page`, `limit`, `status`, `orderNumber`; ADMIN-only `cashierId` | `200` `{orders, total, page, limit}` |
| GET | `/api/orders/:id` | Both*; owner or ADMIN | Positive order ID | `200` order with items directly |
| PUT | `/api/orders/:id` | Both*; owner or ADMIN | JSON full replacement `items` | `200` `{message, order}`; pending only |
| POST | `/api/orders/:id/cancel` | Both*; owner or ADMIN | No body or empty JSON object | `200` `{message, order}`; retains history |
| POST | `/api/orders/:id/payments` | Both*; owner or ADMIN | `requestId`, `method`; CASH requires `cashReceived` | `201` new payment, `200` replay, `202` unresolved; `{message, order, payment}` |
| GET | `/api/orders/:id/payments` | Both*; owner or ADMIN | Positive order ID; no query | `200` `{order, payments}`; complete attempt history |
| POST | `/api/orders/:id/payments/:paymentId/reconcile` | Both*; owner or ADMIN | No body or empty JSON object; no query | `200` terminal, `202` pending; `{message, order, payment}` |
| POST | `/api/payments/midtrans/notification` | Public; signature plus provider verification | Midtrans JSON notification | `200` `{message}` after durable processing |

### Pending orders

Create an order with `POST /api/orders` or replace its complete item selection with `PUT /api/orders/:id`:

```json
{
  "items": [
    {"productId": 1, "quantity": 2},
    {"productId": 2, "quantity": 1}
  ]
}
```

- JSON only; 1–100 distinct product IDs, integer `productId` from 1 to 2147483647, integer `quantity` from 1 to 999. Duplicates, unknown fields, empty selections and client-supplied prices/totals/status/cashier fields return `400`. Missing/unavailable **new** products return `400`.
- Server generates `OC-<UUID>` order number, sets `PENDING`, and attributes order to current authenticated user, including an ADMIN creating an order. CASHIER can access only own orders; foreign or missing order IDs return `404`. ADMIN can read/edit/cancel any order without changing its original owner.
- Creation requires cafe settings (`id=1`); absent settings return `409`. It snapshots cafe name/address/logo URL, cashier name, product names/prices and enabled tax rules. No migration is automatically deployed or missing settings silently created.
- Existing lines retain captured names/prices on quantity edits even after catalog rename, repricing or unavailability. Newly selected products capture current available catalog. Omitted products are removed; adding them again in a later request uses current catalog. Order tax/receipt/owner snapshots stay unchanged after edits. Item row IDs may change; use `productId` to identify selection. Identical selection succeeds without changing timestamps/items.
- Amounts and `taxRate` are fixed two-decimal strings, including nested `unitPrice` and `subtotal`. Line subtotal equals captured price times quantity. `subtotalAmount` sums line subtotals. Money uses exact integer cents, not floating point, and is bounded by `9999999999.99`; overflowing line/order/tax/total returns `400`.
- Disabled tax captures `taxName=null`, `taxRate="0.00"`, `taxAmount="0.00"`, `taxInclusive=false`. Exclusive tax is subtotal times rate; tax is added to total. Inclusive tax is subtotal times rate divided by `(100 + rate)`; tax is already contained in subtotal and total equals subtotal. Round half up once per order, not once per line. Example: exclusive 10% of `0.05` gives tax `0.01`, total `0.06`; inclusive 10% of `0.05` gives tax `0.00`, total `0.05`.
- Pending edits/cancellation return `409` when any `PENDING` or `PAID` payment exists. No payment rows are created/modified by these endpoints. Financial edits to cancelled/completed orders return `409`. Invalid legacy financial snapshots or null product references block editing with `409` instead of inventing history; cancellation can preserve legacy rows unchanged. Legacy signed stored amounts are returned as signed fixed-decimal strings, not repaired or accepted for new pricing.
- Cancel using `POST /api/orders/:id/cancel` without body or with `{}` as JSON. PENDING becomes CANCELLED, retaining items/amounts; `completedAt` stays null. Repeated cancellation succeeds unchanged; COMPLETED cancellation returns `409`. No hard deletion, generic status setter or completion endpoint.
- Lists default to `page=1`, `limit=20`, `status=PENDING`; maximum limit100 and signed-32-bit offset. Status filter accepts `PENDING`, `CANCELLED`, `COMPLETED`, `ALL`; `orderNumber` is exact match, nonempty and at most50 code points. Only ADMIN may supply `cashierId`. Unknown/duplicate/array parameters and malformed percent/UTF-8 query encoding return `400`. Known minor limitation: malformed encoding after a second literal `?` in the query can bypass raw encoding validation and become replacement text. Sort newest `createdAt` first, then descending ID. List rows include `_count.items`; detail includes items ordered by item ID. List count/rows share one consistent read; different pages are not frozen together.
- Mutations recheck live role/session/account state under actor/order locks. Concurrent edit/cancel is serialized; concurrent full edits use last committed selection, not merge/version checks. Deadlock/write conflict returns `409`. No durable create-idempotency key: do not blindly retry POST after an uncertain response because duplicate orders are possible.
- Receipt logo snapshot stores URL, not retained image bytes. Replacing/deleting cafe images may remove old files; historical image rendering is not promised. Payments complete orders through checkout below; no stock reservation, customer/table fields or receipt renderer.

Example create response with captured unit price `12.50`, quantity2 and exclusive10% tax (IDs and timestamps omitted here):

```json
{
  "message": "Order created successfully",
  "order": {
    "orderNumber": "OC-f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "status": "PENDING",
    "cashierId": 7,
    "subtotalAmount": "25.00",
    "taxName": "PBJT",
    "taxRate": "10.00",
    "taxInclusive": false,
    "taxAmount": "2.50",
    "totalAmount": "27.50",
    "items": [{"productId": 1, "productName": "Coffee", "unitPrice": "12.50", "quantity": 2, "subtotal": "25.00"}]
  }
}
```

### CASH and QRIS payments

Configure server-side secrets in ignored `.env`, never in client code or tracked files:

```dotenv
MIDTRANS_ENV=sandbox
MIDTRANS_SERVER_KEY=
MIDTRANS_SIGNATURE_SECRET_KEY=
```

`MIDTRANS_ENV` accepts `sandbox` (default) or explicitly configured `production`, selecting fixed HTTPS Midtrans hosts. Missing/invalid provider settings disable QRIS, not CASH. API authorization uses Server Key; notifications use the separate Signature Secret Key, not Client Key or Server Key. See [Midtrans access keys](https://docs.midtrans.com/docs/access-keys). No SDK, Snap token or hosted checkout is used.

Create CASH payment:

```json
{"requestId":"123e4567-e89b-42d3-a456-426614174000","method":"CASH","cashReceived":"20000.00"}
```

Create QRIS payment:

```json
{"requestId":"123e4567-e89b-42d3-a456-426614174001","method":"QRIS"}
```

- Both use `POST /api/orders/:id/payments`, JSON only, exact field allowlists. `requestId` is a canonical lowercase UUID. Same order/key and normalized method/tender returns existing attempt without redispatch; different fields with same key return `409`. Use a new key only after a verified terminal failure permits a new attempt. Never retry an uncertain charge under a new key.
- CASHIER accesses own orders; ADMIN accesses any. Missing/foreign resources return `404`. Live account/session/role and password-change state are rechecked after acquiring order lock and before protected payment disclosure. Provider results persist even if initiating employee loses access during transport.
- Checkout uses captured item/tax snapshots, not current catalog prices or availability. Payment `orderTotalAmount` retains exact order total; `amount` is payable whole rupiah, rounded half up; signed `roundingAdjustment = amount - orderTotalAmount`. Order totals/items remain unchanged. Example: `12.49` becomes `12.00` with `-0.49`; `12.50` becomes `13.00` with `0.50`.
- Monetary responses use fixed two-decimal strings. `cashReceived` accepts plain decimal string or JSON number, 0–9999999999.99 with at most two decimals. Raw numeric exponent/excess precision is rejected before Number rounding. Tender must cover payable; exact change is `cashReceived - amount`. CASH accepts zero payable and marks payment `PAID`, order `COMPLETED`, `paidAt` and `completedAt` in one transaction. Rounded payable overflow returns `400`.
- QRIS accepts payable IDR1–10,000,000 inclusive; issuer/merchant limits may be stricter. One PENDING attempt and dispatch claim commit before native charge request; no SQL transaction spans network work. Response includes safe QR image URL (`qrisQrUrl`) and/or QR payload when available, provider IDs and expiry when supplied. QRIS `201` means attempt created, not paid. `202` means pending without usable QR details or unresolved creation; reconcile that attempt, never resend it.
- `GET /api/orders/:id/payments` returns all attempts ordered by `attemptNumber`, with request ID, method/status, amounts, cash/change, QR details, provider IDs, timestamps and safe reconciliation reason. No provider request occurs. Legacy new snapshot fields remain null; history is never reconstructed from current catalog.
- `POST /api/orders/:id/payments/:paymentId/reconcile` accepts no fields, requires QRIS and fetches authoritative provider status. Pending returns `202`; verified terminal state `200`; conflict `409` only after evidence/hold commits. Transport failure returns `502`; configuration or recognized lock contention may return `503`. Reconciliation does not charge again. No public generic status setter exists.
- Notification signature is SHA512 of original `order_id + status_code + gross_amount + SignatureSecretKey`, compared timing-safely. A valid signature does not authenticate supplied transaction status: handler independently retrieves current provider status and compares QRIS method, IDR currency, amount and transaction identity before changing money state. Duplicate notifications requery; stale failure cannot regress PAID. Notifications return `400` malformed, `403` bad signature, `404` unknown signed order, `503` transient provider/DB failure, or `200` after processing, including durably recorded financial conflicts.
- Settlement completes an eligible pending order atomically. Verified expiry maps to EXPIRED; deny/cancel to FAILED, only when fresh lookup began after dispatch finished locally. Local clock expiry, provider not-found and transport failure never release an unresolved attempt. Late settlement after terminal failure/replacement, invalid financial identity, provider transaction-ID collision, unsupported refund/status or fraud review retains bounded financial evidence and places order on reconciliation hold. Previous successful payment is never overwritten.
- Pending/paid attempts and `paymentHoldReason` block additional checkout, edits and cancellation. Legacy attempts lacking immutable snapshots also block changes, exposing `LEGACY_PAYMENT_REQUIRES_RECONCILIATION` through payment-history projection. Incoherent stored snapshots require operator investigation, not fabricated backfill. Forward migration adds nullable fields and replay uniqueness without rewriting old financial values.

**Availability restriction:** A crash after dispatch claim but before durable dispatch completion can leave that order blocked indefinitely, even if provider later reports not found or a terminal failure. There is no force-clear, resend, worker, refund or supported recovery operation in this scope. Do not manually clear holds or create replacement payments without a separately reviewed recovery procedure.

For deployment, route HTTPS callback URL to `POST /api/payments/midtrans/notification` and register it in the matching Midtrans environment only after testing ingress/signatures. Keep API loopback-bound behind your configured proxy. No tunnel/dashboard registration is automatic. Sandbox QR codes must only be paid through the [official sandbox simulator](https://simulator.sandbox.midtrans.com/v2/qris/index), never a real bank/payment app. Public provider-to-webhook delivery requires separate verification; signed local callbacks or protected reconciliation do not prove it.

### Image uploads

These existing endpoints accept multipart data with one optional file:

| Endpoint | File field | Stored path |
| --- | --- | --- |
| `POST /api/cafe`, `PUT /api/cafe` | `logo` | `uploads/cafe/<random-id>.webp` |
| `POST /api/admin/users` | `image` | `uploads/user/<new-user-id>/<random-id>.webp` |
| `PUT /api/auth/profile` | `image` | `uploads/user/<authenticated-id>/<random-id>.webp` |
| `PUT /api/admin/cashiers/:id` | `image` | `uploads/user/<cashier-id>/<random-id>.webp` |
| `POST /api/products`, `PUT /api/products/:id` | `image` | `uploads/product/<product-id>/<random-id>.webp` |

- Allowlisted input: `.jpg`, `.jpeg`, `.png`, `.webp` (case-insensitive), with matching MIME type **and decoded image format**. Renaming another file to an image extension does not make it valid.
- Maximum file size: 5 MiB. Maximum decoded area: 16,000,000 pixels; maximum side: 8192 pixels. SVG, animated/multiple-frame images, malformed/truncated images, unexpected file fields, and multiple files are rejected.
- Sharp auto-orients, removes metadata, and re-encodes as WebP at quality 80. Original filenames and original files are not stored. Files use random UUID names.
- Multipart booleans must be the exact strings `true` or `false`; duplicate/array fields are rejected. Text is limited to 80 KiB total, at most 16 fields. Multipart text containing U+FFFD is rejected because malformed UTF-8 cannot safely be distinguished after decoding; use JSON for a literal replacement character.
- Four multipart requests can be active per process. Excess requests return `429`; limits are not shared across instances.
- Send non-image JSON changes as before. Client-supplied non-null `imageUrl` and `logoUrl` are rejected. Use JSON `null` to clear; uploading and clearing in the same request is rejected. Omitting both retains the current image.
- Example generated URL: `http://localhost:3001/uploads/user/12/<random-id>.webp`. URLs are built from configured `IMAGE_BASE_URL`, never the request's Host header.
- Existing legacy external URLs stay readable until replaced or cleared. Only canonical locally managed files are deleted. After successful replacement/clear or cafe deletion, the previous local file is removed. Failed database writes remove the new file and retain the previous image.
- Uploads are ignored by Git. Back up `uploads/` with the database and keep it writable only by the application account. Local storage supports a single host; use shared storage before multi-host deployment. A process crash between filesystem and database operations can leave orphan files; filesystem writes and SQL commits are not one atomic transaction. Post-commit cleanup failures are logged for operator action.

**Uploaded images are public on the image port. No bearer token is needed to read them. Only generated WebP paths are served; API routes, original uploads, directory listings, and dotfiles are not exposed there. The API port does not serve uploads.**

Examples (use a valid access token after completing required password change):

```sh
# Create cafe settings with a logo.
curl -X POST http://localhost:3000/api/cafe \
  -H "Authorization: Bearer $TOKEN" \
  -F 'name=OpenCafe' -F 'address=123 Cafe Street' \
  -F 'taxEnabled=true' -F 'taxInclusive=false' \
  -F 'logo=@./logo.png;type=image/png'

# Replace own profile image; no other fields required.
curl -X PUT http://localhost:3000/api/auth/profile \
  -H "Authorization: Bearer $TOKEN" \
  -F 'image=@./avatar.jpg;type=image/jpeg'

# Administrator changes cashier image/status.
curl -X PUT http://localhost:3000/api/admin/cashiers/12 \
  -H "Authorization: Bearer $TOKEN" \
  -F 'isActive=true' -F 'image=@./avatar.webp;type=image/webp'

# Clear own profile image using JSON.
curl -X PUT http://localhost:3000/api/auth/profile \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"imageUrl":null}'
```

### Authentication and sessions

Login body:

```json
{
  "username": "admin",
  "password": "ChangeMeBeforeUse!"
}
```

Example session response structure (login and refresh):

```json
{
  "message": "Login successful",
  "accessToken": "<JWT>",
  "expiresIn": 900,
  "user": {
    "id": 1,
    "name": "Administrator",
    "username": "admin",
    "role": "ADMIN",
    "mustChangePassword": true,
    "imageUrl": null
  }
}
```

- Access tokens use HS256, issuer `opencafe`, audience `opencafe-api`, user ID as subject, and a session ID claim. Every authenticated request also checks the live account and database session.
- Refresh token cookie: `opencafe_refresh`, `HttpOnly`, `SameSite=Strict`, `Path=/api/auth`, and `Secure` in production. Only SHA-256 refresh-token digests are stored in the database.
- Refresh rotates the cookie without extending the original 30-day session expiry. Reusing a consumed refresh token revokes that session, including its access token. Serialize refresh requests in clients; concurrent reuse can revoke the winning request's session too.
- Logout revokes the session identified by the supplied refresh cookie, not every device. Missing or malformed cookies still receive a successful logout response. Logout does not use a bearer token to identify the session.
- Login, refresh, and logout reject cross-site fetches and a supplied `Origin` that differs from `APP_ORIGIN`. Non-browser clients may omit `Origin`. CORS middleware is not configured; use a same-origin frontend/reverse proxy rather than assuming cross-origin browser access is enabled.
- Login, own-password changes, and administrator cashier resets each have separate in-memory rate budgets: 20 requests per IP and 10 per account per 15 minutes. Authenticated budgets use the acting user ID; cashier resets share the administrator's budget across targets. Successful requests count too. Hash work is additionally capped at four concurrent jobs per process.
- Rate limits are per process, not shared across instances. Proxy trust is not configured in production code; a reverse proxy affects which IP Express sees. Review proxy trust and shared limits before multi-instance deployment.

Example login and refresh with a local cookie jar:

```sh
curl -c cookies.txt -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"ChangeMeBeforeUse!"}'

# Copy accessToken from the login response into TOKEN.
TOKEN='<accessToken>'

curl http://localhost:3000/api/auth/me \
  -H "Authorization: Bearer $TOKEN"

curl -b cookies.txt -c cookies.txt -X POST http://localhost:3000/api/auth/refresh

curl -b cookies.txt -c cookies.txt -X POST http://localhost:3000/api/auth/logout
```

Treat access tokens and cookie jars as credentials; never commit them. Refresh returns a new access token and replaces the cookie.

### User registration, profiles, and passwords

| Field | Validation / behavior |
| --- | --- |
| `name` | Required at registration; trimmed, nonempty, well-formed Unicode, at most 100 code points |
| `username` | Required at registration/login; 1–100 ASCII letters, digits, `_`, `.`, or `-`; normalized to lowercase; unique |
| `password`, `currentPassword`, `newPassword` | Well-formed Unicode, 12–128 UTF-8 bytes; exact bytes preserved, not trimmed |
| `role` | Registration only: `ADMIN` or `CASHIER`; omitted defaults to `CASHIER` |
| `imageUrl` | Server-generated response URL; non-null client values rejected; JSON `null` clears it. Upload file field `image` instead |
| `isActive` | Cashier editing only; strict JSON boolean |

Registration example (`POST /api/admin/users`):

```json
{
  "name": "Cashier One",
  "username": "cashier.one",
  "password": "Replace-with-unique-password!",
  "role": "CASHIER"
}
```

New accounts are active and require a password change before protected work. There is no public registration route. Administrators can register another administrator but cannot target an administrator through cashier-management routes.

Own-profile example (`PUT /api/auth/profile`):

```json
{
  "name": "Updated Name",
  "username": "updated.name",
  "imageUrl": null
}
```

Updates are partial despite using `PUT`: omitted fields stay unchanged. Neither role can change its own `role`, `isActive`, or password through this endpoint.

Own-password example (`PUT /api/auth/password`):

```json
{
  "currentPassword": "ChangeMeBeforeUse!",
  "newPassword": "Replace-with-unique-password!"
}
```

The new password must differ from the current password. A successful change clears `mustChangePassword`, revokes **all** of the user's sessions, and clears the refresh cookie. Sign in again with the new password.

### Cashier management

- List query defaults: `page=1`, `limit=20`; maximum `limit=100`. Only `page` and `limit` are accepted. Both must be positive decimal integers without leading zeros; offsets must fit a signed 32-bit integer. Results are ordered by ascending ID; `total` counts all cashiers, including inactive accounts.
- `:id` must be a positive signed 32-bit integer without leading zeros. Missing users and `ADMIN` targets return `404`.
- Detail and edit responses use `{cashier}`; edits also include a message. List entries and detail/edit results include `isActive`.
- Edit profile fields or deactivate with `PUT /api/admin/cashiers/:id`:

  ```json
  {
    "name": "Cashier Updated",
    "imageUrl": null,
    "isActive": false
  }
  ```

- Deactivation revokes all target sessions immediately. Setting `isActive=true` allows a fresh login but does not restore revoked sessions. Accounts and order history are retained; there is no delete route or role-change field.
- Reset a cashier password with `PUT /api/admin/cashiers/:id/password`:

  ```json
  {
    "newPassword": "Admin-chosen-unique-password!"
  }
  ```

  The administrator supplies the password. The API hashes it, revokes all cashier sessions, and sets `mustChangePassword=true`. It never generates or returns a plaintext password. Deliver the chosen password securely; the cashier must sign in and change it before continuing. A reset does not reactivate an inactive cashier.

### Products and categories

Categories have unique trimmed names (1–100 Unicode characters). POST/PUT category requests require JSON. Product fields:

| Field | Create requirement / default | Validation |
| --- | --- | --- |
| `name` | Required | Trimmed, 1–150 Unicode characters |
| `price` | Required | Number or decimal string, 0–9999999999.99, at most 2 decimal places; no signs/exponents |
| `description` | Optional / `null` | Nonempty trimmed text, at most 65535 UTF-8 bytes, or JSON `null` |
| `categoryId` | Optional / `null` | Existing positive signed-INT category ID, or JSON `null`; multipart uses canonical integer text |
| `isAvailable` | Optional / `true` | JSON boolean or multipart `true`/`false` |
| `image` | Optional file | Multipart JPEG/PNG/WebP under shared image limits |
| `imageUrl` | Server-owned / `null` | Only JSON `null` accepted to clear; non-null client URLs rejected |

PUT is partial: omitted fields remain unchanged, empty updates fail. JSON `null` clears description/category/image; multipart `"null"` is not null. Unknown fields, duplicate/array query/form fields, malformed Unicode and invalid IDs return `400`. Missing detail/update/delete records return `404`; nonexistent category assignments return `400`. Duplicate category names return `409` (database collation governs uniqueness). Product responses include `category: {id, name}` or `null`, timestamps and price serialized as a decimal string; no order items included.

JSON numeric prices are validated from their original tokens before floating-point conversion, so exponent notation and excess precision are rejected rather than rounded. Decimal strings are recommended for monetary clients.

Lists accept `page=1`, `limit=20` (max 100) and optional trimmed `search` (1–150 characters, name substring). IDs/pagination must be positive integers without leading zeros; offsets must fit a signed 32-bit integer. Results sort by ascending ID. Products also accept `categoryId` and exact query `isAvailable=true`/`false`. Both roles can read unavailable products; filter explicitly when needed. Unknown/duplicate query fields return `400`. Known limitation: malformed percent-encoded UTF-8 in search queries can be decoded to U+FFFD and treated as search text rather than rejected.

`DELETE /api/products/:id` retains product, image and order relationships, setting `isAvailable=false`. Repeat deletion succeeds; restore with `PUT` and `isAvailable=true`. `DELETE /api/categories/:id` returns `409` while **any** product references it, including unavailable products. Reassign or clear those product categories first. Historical order snapshots remain unchanged. Mutations recheck administrator/session state under transaction locks; concurrent reference conflicts return `409` rather than silently changing assignments.

Create category:

```json
{"name": "Coffee"}
```

Create product (`POST /api/products`):

```json
{"name": "Espresso", "price": "18000.00", "categoryId": 1, "isAvailable": true}
```

Upload image with creation (use real category ID):

```sh
curl -X POST http://localhost:3000/api/products \
  -H "Authorization: Bearer <access-token>" \
  -F 'name=Espresso' -F 'price=18000.00' -F 'categoryId=1' \
  -F 'isAvailable=true' -F 'image=@./espresso.png;type=image/png'
```

Example list: `GET /api/products?page=1&limit=20&search=Espresso&categoryId=1&isAvailable=true`.

### Cafe settings

A single record is managed at ID `1`; there is no ID path parameter. Creating it twice returns `409`. Reading, updating, or deleting a missing record returns `404`. `PUT` updates only supplied fields.

| Field | Create requirement / default | Validation |
| --- | --- | --- |
| `name` | Required | Trimmed, nonempty string, at most 150 code points |
| `address` | Required | Trimmed, nonempty string, at most 65,535 UTF-8 bytes and code points; request-size limit still applies |
| `logoUrl` | Optional; `null` | Server-generated URL; client non-null URLs rejected. Use multipart file `logo`, or JSON `null` to clear |
| `taxEnabled` | Optional; `false` | JSON boolean |
| `taxName` | Optional; `PBJT` | Trimmed, nonempty string, at most 50 code points |
| `taxRate` | Optional; `10.00` | Number or decimal string from 0 to 100, at most two decimal places |
| `taxInclusive` | Optional; `false` | JSON boolean |

Example creation (`POST /api/cafe`):

```json
{
  "name": "OpenCafe",
  "address": "123 Cafe Street",
  "taxEnabled": true,
  "taxName": "PBJT",
  "taxRate": "10.00",
  "taxInclusive": false
}
```

Settings responses contain the fields above plus `id`, `createdAt`, and `updatedAt`. Prisma Decimal values such as `taxRate` serialize as strings; timestamps serialize as ISO date-time strings. `GET /api/cafe` returns that object directly, while create/update wrap it in `cafeSetting`.

### Errors

Handled errors generally use `{ "message": "..." }`; forced-password-change errors additionally include `code`. Validation messages currently mix English and Indonesian. Unknown routes use Express's default `404` response, not a custom JSON envelope.

| Status | Meaning |
| --- | --- |
| `400` | Invalid fields, body, JSON/UTF-8, oversized JSON, missing required JSON content type, or invalid pagination/ID |
| `401` | Invalid credentials, invalid/expired access token, missing/invalid refresh cookie, inactive account, or expired/revoked session |
| `403` | Wrong role, pending required password change, denied origin, or administrator permission changed |
| `404` | Missing cafe settings, cashier, product or category, or non-cashier management target |
| `409` | Duplicate username/category name, existing singleton cafe settings, referenced category deletion, or concurrent catalog conflict |
| `413` | Uploaded image or multipart text exceeds size limits |
| `429` | Authentication rate limit, hash-concurrency budget, or image-upload admission limit reached |
| `500` | Server/database error; unsupported JSON charset/encoding currently also falls through to the generic server error handler |
| `502` | Midtrans request/status unavailable; unresolved payment must be reconciled, not recharged |
| `503` | Midtrans configuration unavailable, retryable payment contention, or notification processing unavailable |

## Checks

Test scripts are intentionally ignored and are not included in fresh clones. `npm test` can exit successfully with **zero tests** when no local `scripts/*.check.js` files exist; that is not verification.

Available source/schema checks:

```sh
npx prisma generate
npx prisma validate
npm audit
git diff --check
```

Local catalog checks, when present, run explicitly:

```sh
node --import tsx --test scripts/catalog.check.js
DATABASE_NAME=pos_auth_test \
AUTH_TEST_DATABASE_ACK=<test-host>:<test-port>/pos_auth_test \
node --import tsx --test scripts/catalog.integration.js
```

Integration checks require explicit test-target acknowledgement, create uniquely named fixtures in `pos_auth_test`, and clean only their own rows/files. Credentials come from the environment or ignored `.env`. The acknowledgement must match `DATABASE_HOST:DATABASE_PORT/DATABASE_NAME` (port defaults to 3306). Never point fixture checks at production or reset existing databases to satisfy a test. Catalog verification includes role/forced-change guards, validation, filters/pagination, category assignment/deletion races, unavailable retention, images/replacements and rollback cleanup.

Local payment checks, when present:

```sh
npm test
node --import tsx --test scripts/payment.integration.js
node scripts/payment-migration.js
node --import tsx scripts/payment.sandbox.js --ack-sandbox --reconcile --expect-paid
```

These scripts are ignored local artifacts, not available in fresh clones. Offline tests cover money/signatures/bounded transport; integration checks exercise mounted HTTP against an explicitly allowlisted test schema with mocked provider HTTP and fixture-owned cleanup. Target verification compares Prisma CLI and runtime database identities before writes. Migration rehearsal uses connection-local temporary tables and preserves legacy values; it is distinct from fresh migration deployment. Sandbox check deliberately retains its fixture and real sandbox provider IDs for repeatable readback; it never runs from ordinary `npm test`. Never point fixture checks at production or change their target allowlist without authorization. Genuine sandbox charge/status/simulator settlement and persisted PAID/COMPLETED readback have been exercised; public provider-to-webhook delivery has not.

## Project layout

```text
prisma/schema.prisma          Database models
prisma/migrations/            Forward SQL migrations and bootstrap admin
prisma7.config.ts             Prisma CLI datasource configuration
src/app.js                    Express middleware and route mounts
src/server.js                 HTTP listener and shutdown handlers
src/configs/prisma.js         MariaDB adapter and generated Prisma client
src/controllers/              Direct Prisma request handlers
src/middlewares/              Authentication, roles, origin/JSON checks, limits
src/routes/                   Auth, administrator, cafe, catalog, order and payment routers
src/utils/                    Validation, passwords/JWT, sessions, projections
scripts/                     Ignored local verification scripts (not shipped)
src/image.app.js              WebP-only public image server
uploads/                      Ignored local WebP files
```

## License

MIT. See [LICENSE](LICENSE).
