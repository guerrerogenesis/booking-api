# Booking API

**English** · [Español](README.es.md)

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

## Endpoints

| Method | Path             | Auth | Description                                  |
| ------ | ---------------- | ---- | -------------------------------------------- |
| GET    | `/health`        | —    | Health check                                 |
| POST   | `/auth/register` | —    | Create a `CLIENT` or `PROFESSIONAL` account  |
| POST   | `/auth/login`    | —    | Returns a JWT (valid for 1 hour)             |
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

### Password reset security

- Same response whether or not the email exists, so accounts can't be enumerated.
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
without touching business code. Email (SMTP via nodemailer) is the default; select the channel
with `NOTIFIER_CHANNEL`. To add SMS or WhatsApp, implement `Notifier` in `src/notifications/`
and register it in `createNotifier()`.

In development, emails are caught by [Mailpit](https://mailpit.axllent.org/): open http://localhost:8025.

## Scripts

| Command             | Description            |
| ------------------- | ---------------------- |
| `npm run dev`       | Start with hot reload  |
| `npm test`          | Run tests (uses a separate `booking_test` database) |
| `npm run typecheck` | Type-check the project |
| `npm run build`     | Compile to `dist/`     |

Questions? [Email me](mailto:guerrerogenesisd@gmail.com).
