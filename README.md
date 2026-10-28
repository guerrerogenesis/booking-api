# Booking API

[![CI](https://github.com/guerrerogenesis/booking-api/actions/workflows/ci.yml/badge.svg)](https://github.com/guerrerogenesis/booking-api/actions/workflows/ci.yml)

**English** · [Español](README.es.md)

**Live demo:** [booking-api-rg2g.onrender.com/docs](https://booking-api-rg2g.onrender.com/docs) (free instance: the first request after a while can take up to a minute)

| Demo account | Email | Password |
| ------------ | ----- | -------- |
| Professional | `pro.demo@example.com` | `Demo$ecret1` |
| Client       | `client.demo@example.com` | `Demo$ecret1` |

Log in with `POST /auth/login`, click **Authorize** and paste the token. The demo sends no emails,
so new registrations can't be verified there; the demo accounts are restored on every boot.

<!-- portfolio:en -->
REST API for booking appointments with professionals. The database itself prevents overlapping appointments, and the password reset flow is built to resist account enumeration and brute-force attempts.
<!-- /portfolio:en -->

**Stack:** Node.js, TypeScript, Fastify, Prisma, PostgreSQL, Zod, Vitest.

## Key design decision: no double booking

Two layers make sure two concurrent requests for the same slot can't both succeed:

1. **Row lock.** A booking locks the professional's row (`SELECT ... FOR UPDATE`), then
   recomputes the free slots and only accepts a start time that is one of them.
2. **Exclusion constraint.** Even if application code had a bug, PostgreSQL itself rejects
   overlapping confirmed appointments, and the API answers `409`, not `500`.

A test fires two simultaneous bookings and checks that exactly one wins.

```sql
EXCLUDE USING gist (
  "professionalId" WITH =,
  tstzrange("startsAt", "endsAt", '[)') WITH &&
) WHERE ("status" = 'CONFIRMED')
```

## Getting started

Requires Node 20+ and Docker.

```bash
cp .env.example .env
docker compose up -d
npm install
npx prisma migrate dev
npm run dev        # http://localhost:3000/health
```

## API docs

Interactive OpenAPI 3.1 docs at http://localhost:3000/docs (raw spec at `/docs/json`).

- **Generated from the code.** Request schemas are the same Zod schemas the handlers validate
  with, converted with `z.toJSONSchema`, so the docs can't drift from the validation.
- **Every route must be documented**, or the app refuses to start.
- **Contract test.** `src/docs.test.ts` walks the whole booking flow and checks every response's
  status is documented and its body matches the strict response schema, so an undocumented
  or leaked field (like an email) fails the build.

### Postman

Import `postman/booking-api.postman_collection.json` and `postman/local.postman_environment.json`.
Running the collection top to bottom against your local setup walks the whole flow, unattended:
each request saves the tokens and ids the next ones need, every run registers fresh accounts, and
the emailed verification and reset codes are read from Mailpit.

## Endpoints

| Method | Path             | Auth | Description                                  |
| ------ | ---------------- | ---- | -------------------------------------------- |
| GET    | `/health`        | —    | Health check                                 |
| POST   | `/auth/register` | —    | Create a `CLIENT` or `PROFESSIONAL` account and email a verification code |
| POST   | `/auth/verify-email` | — | Verify the email with the code (required before logging in) |
| POST   | `/auth/verify-email/resend` | — | Send a new verification code (always `202`) |
| POST   | `/auth/login`    | —    | Returns a JWT (valid for 1 hour; `403` if the email isn't verified) |
| GET    | `/auth/me`       | JWT  | Current user                                 |
| POST   | `/auth/password-reset/request` | — | Email a 6-digit code (always `202`)  |
| POST   | `/auth/password-reset/verify`  | — | Exchange the code for a reset token  |
| POST   | `/auth/password-reset/confirm` | — | Set a new password with the token    |
| GET    | `/professionals/:id` | — | Public profile with services and weekly availability |
| GET    | `/professionals/:id/slots?serviceId&date` | — | Free start times for a service on a date |
| GET    | `/professionals/me`  | Professional | Own profile                           |
| PATCH  | `/professionals/me`  | Professional | Update bio, timezone and booking settings |
| POST   | `/professionals/me/services` | Professional | Create a service              |
| PATCH  | `/professionals/me/services/:serviceId` | Professional | Update a service   |
| DELETE | `/professionals/me/services/:serviceId` | Professional | Delete a service (`409` if it has appointments) |
| PUT    | `/professionals/me/availability` | Professional | Replace the weekly schedule |
| GET    | `/professionals/me/time-off` | Professional | Upcoming days out of service    |
| POST   | `/professionals/me/time-off` | Professional | Add days out of service (`409` if appointments exist on them) |
| DELETE | `/professionals/me/time-off/:timeOffId` | Professional | Remove time off      |
| POST   | `/appointments`              | Client | Book a free slot (`409` if not available) |
| GET    | `/appointments/me?scope&limit&offset` | JWT | Own appointments (`upcoming` or `past`) |
| POST   | `/appointments/:id/cancel`   | JWT    | Cancel: clients need 48h notice, professionals any time before start |
| POST   | `/appointments/:id/reschedule-requests` | Client | Propose a new time (48h notice, one pending at a time) |
| GET    | `/appointments/:id/reschedule-requests` | JWT    | Request history for the appointment |
| POST   | `/appointments/:id/reschedule-requests/:requestId/accept` | Professional | Move the appointment to the proposed time |
| POST   | `/appointments/:id/reschedule-requests/:requestId/reject` | Professional | Reject, with an optional `reason` |
| POST   | `/appointments/:id/reschedule-requests/:requestId/withdraw` | Client | Withdraw a pending request |
| POST   | `/appointments/:id/reschedule` | Professional | Move an appointment directly, any time before it starts |

Both parties are notified when an appointment is booked, moved or cancelled.

Reschedule requests don't hold the proposed time: accepting re-checks it under the same lock as
bookings. A partial unique index allows only one `PENDING` request per appointment, and pending
requests expire automatically once fewer than 48 hours remain (checked lazily, no background job).

Each professional has an IANA `timezone` (e.g. `America/Mexico_City`); weekly availability and
time off are interpreted in it. Optional booking settings: `maxAppointmentsPerDay` and
`bufferMinutes` between appointments.

Routes under `/professionals/me` only ever query the authenticated professional's own data,
so ownership is enforced by the queries themselves. Another professional's service returns
`404`, not `403`, so its existence isn't revealed.

Passwords are hashed with Node's built-in `scrypt` (random salt per user) and must be
8–128 characters with an uppercase letter, a lowercase letter, a number and a symbol, and no spaces.

### Email verification and abuse protection

Every account triggers emails, so the API makes sure it only writes to addresses whose owner asked for it:

- New accounts get a 6-digit code (same rules as password reset codes) and can't log in until verified,
  so nothing else (bookings, reminders, reset codes) is ever sent to an unverified address.
- Registration is rate limited to 5 per hour per IP.
- A global cap (`NOTIFICATION_DAILY_LIMIT`, default 100 per UTC day) decorates the notifier, so even
  traffic from many IPs can't exhaust the email provider's quota. The counter is an atomic upsert in
  PostgreSQL, so it survives restarts and is exact under concurrency.
- If someone registers your email first, you can still claim it: request a new verification code,
  verify, then reset the password.

### Password reset security

- Same response whether or not the email exists, so accounts can't be enumerated. Codes are only sent to verified emails.
- Codes expire after 15 minutes, allow 5 attempts, and are stored as an HMAC, never in plain text.
- A new code can't be requested within 60 seconds of the previous one.
- The reset token is single-use, even under concurrent requests.
- Per-IP rate limiting on login and every reset step (`429` with `Retry-After`).

## Available slots

`computeSlots` (`src/professionals/slots.ts`) is a pure function, unit-tested without a database:

1. The date is read in the professional's timezone (DST-aware). Time off or a full day (`maxAppointmentsPerDay`) means no slots.
2. Adjacent availability blocks are merged, so a service can span 09–12 and 12–15.
3. Start times every 15 minutes where the whole service fits.
4. Times that clash with confirmed appointments, including `bufferMinutes` before and after, are dropped.
5. Booking window: at least 2 hours ahead, at most 60 days ahead.

## Notifications

Notifications go through a `Notifier` interface (adapter pattern), so the channel can change
without touching business code. Select the channel with `NOTIFIER_CHANNEL`:

- `email` (default): SMTP via nodemailer.
- `log`: sends nothing and logs the recipient and subject (never the body, which may hold codes).
  The public demo uses it: with real emails, anyone could register throwaway addresses and burn
  the provider quota.

To add SMS or WhatsApp, implement `Notifier` in `src/notifications/` and register it in `createNotifier()`.

In development, emails are caught by [Mailpit](https://mailpit.axllent.org/): open http://localhost:8025.

## Deploy

The `Dockerfile` builds a production image (multi-stage, dev dependencies pruned, runs as a
non-root user). On boot it applies pending migrations, restores the demo accounts when
`SEED_DEMO=true`, then starts the server; `SIGTERM` closes it gracefully so in-flight requests finish.

Free setup: API on [Render](https://render.com), database on [Neon](https://neon.tech).

1. Create a Neon project and copy its **direct** (non-pooled) connection string; migrations need it.
2. On Render: **New > Blueprint**, pick this repo. `render.yaml` defines the service; fill in
   `DATABASE_URL`. `JWT_SECRET` is generated for you.
3. The blueprint uses the `log` channel and seeds the demo accounts. To send real emails instead,
   set `NOTIFIER_CHANNEL=email` plus `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and `MAIL_FROM`.
   Render's free plan blocks ports 25, 465 and 587, so pick a provider that accepts port 2525.

Free Render instances sleep after ~15 minutes idle, so the first request can take up to a minute.

`TRUST_PROXY_HOPS` is the number of proxies in front of the app, so rate limits use the real
client IP. On Render it's `3` (Cloudflare plus two Render proxies), measured on the deployed service:
the logged `remoteAddress` matches the client and a forged `X-Forwarded-For` is ignored.
It's a hop count rather than "trust everything" because Render appends
to `X-Forwarded-For` instead of replacing it: trusting the whole header would let a client
spoof its IP and dodge the rate limits. A test proves the spoofed address is ignored.

## Scripts

| Command             | Description            |
| ------------------- | ---------------------- |
| `npm run dev`       | Start with hot reload  |
| `npm test`          | Run tests (uses a separate `booking_test` database) |
| `npm run typecheck` | Type-check the project |
| `npm run build`     | Compile to `dist/`     |
| `npm run db:seed:demo` | Create or restore the demo accounts |

Questions? [Email me](mailto:guerrerogenesisd@gmail.com).
