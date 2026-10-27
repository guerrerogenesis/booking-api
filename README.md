# Booking API

REST API for booking appointments with professionals (barbers, doctors, consultants...).

**Stack:** Node.js, TypeScript, Fastify, Prisma, PostgreSQL, Zod, Vitest.

## Key design decision: no double booking

Overlapping appointments are prevented by a PostgreSQL exclusion constraint,
not just by application code. Two concurrent requests for the same slot cannot
both succeed; the database rejects the second one.

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

Passwords are hashed with Node's built-in `scrypt` (random salt per user) and must be
8–128 characters with an uppercase letter, a lowercase letter, a number and a symbol, and no spaces.

### Password reset security

- Same response whether or not the email exists, so accounts can't be enumerated.
- Codes expire after 15 minutes, allow 5 attempts, and are stored as an HMAC, never in plain text.
- A new code can't be requested within 60 seconds of the previous one.
- The reset token is single-use, even under concurrent requests.
- Per-IP rate limiting on login and every reset step (`429` with `Retry-After`).

In development, emails are caught by [Mailpit](https://mailpit.axllent.org/): open http://localhost:8025.

## Scripts

| Command             | Description            |
| ------------------- | ---------------------- |
| `npm run dev`       | Start with hot reload  |
| `npm test`          | Run tests (uses a separate `booking_test` database) |
| `npm run typecheck` | Type-check the project |
| `npm run build`     | Compile to `dist/`     |

Questions? [Email me](mailto:guerrerogenesisd@gmail.com).
