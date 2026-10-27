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

## Scripts

| Command             | Description            |
| ------------------- | ---------------------- |
| `npm run dev`       | Start with hot reload  |
| `npm test`          | Run tests              |
| `npm run typecheck` | Type-check the project |
| `npm run build`     | Compile to `dist/`     |

Questions? [Email me](mailto:guerrerogenesisd@gmail.com).
