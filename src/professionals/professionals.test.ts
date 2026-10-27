import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createUser } from "../../test/auth.js";
import { resetDb } from "../../test/db.js";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";

const app = buildApp();

type Headers = Record<string, string>;
let pro: Headers;

function call(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, headers: Headers, payload?: object) {
  return app.inject({ method, url: `/professionals${url}`, headers, payload });
}

const service = { name: "Haircut", durationMinutes: 30, priceCents: 25000 };

beforeEach(async () => {
  await resetDb();
  pro = (await createUser(app, "PROFESSIONAL")).headers;
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("access control for /me", () => {
  it("requires a token", async () => {
    expect((await call("GET", "/me", {})).statusCode).toBe(401);
  });

  it("rejects clients", async () => {
    const client = await createUser(app, "CLIENT");
    expect((await call("GET", "/me", client.headers)).statusCode).toBe(403);
    expect((await call("POST", "/me/services", client.headers, service)).statusCode).toBe(403);
  });
});

describe("GET /professionals/:id", () => {
  it("returns the public profile with services and sorted availability", async () => {
    const { professionalId, headers } = await createUser(app, "PROFESSIONAL");
    await call("POST", "/me/services", headers, service);
    await call("PUT", "/me/availability", headers, {
      slots: [
        { weekday: 2, startMinute: 540, endMinute: 720 },
        { weekday: 1, startMinute: 840, endMinute: 1080 },
        { weekday: 1, startMinute: 540, endMinute: 720 },
      ],
    });

    const res = await call("GET", `/${professionalId}`, {});

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id: professionalId,
      name: "Test professional",
      bio: null,
      timezone: "UTC",
      maxAppointmentsPerDay: null,
      bufferMinutes: 0,
      services: [{ id: expect.any(String), ...service }],
      availability: [
        { weekday: 1, startMinute: 540, endMinute: 720 },
        { weekday: 1, startMinute: 840, endMinute: 1080 },
        { weekday: 2, startMinute: 540, endMinute: 720 },
      ],
    });
  });

  it("returns 404 for an unknown id and 400 for a malformed one", async () => {
    expect((await call("GET", "/00000000-0000-4000-8000-000000000000", {})).statusCode).toBe(404);
    expect((await call("GET", "/not-a-uuid", {})).statusCode).toBe(400);
  });
});

describe("PATCH /me", () => {
  it("updates and clears the bio", async () => {
    const updated = await call("PATCH", "/me", pro, { bio: "  10 years of experience  " });
    expect(updated.json().bio).toBe("10 years of experience");

    const cleared = await call("PATCH", "/me", pro, { bio: null });
    expect(cleared.json().bio).toBeNull();
  });

  it("updates the booking settings and normalizes the timezone", async () => {
    const res = await call("PATCH", "/me", pro, {
      timezone: "america/mexico_city",
      maxAppointmentsPerDay: 8,
      bufferMinutes: 15,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ timezone: "America/Mexico_City", maxAppointmentsPerDay: 8, bufferMinutes: 15 });
  });

  it("removes the daily limit with null", async () => {
    await call("PATCH", "/me", pro, { maxAppointmentsPerDay: 8 });
    const res = await call("PATCH", "/me", pro, { maxAppointmentsPerDay: null });

    expect(res.json().maxAppointmentsPerDay).toBeNull();
  });

  it.each([
    ["a bio over 500 characters", { bio: "a".repeat(501) }],
    ["unknown fields", { bio: "ok", name: "Hacker" }],
    ["an empty body", {}],
    ["an unknown timezone", { timezone: "Mars/Olympus_Mons" }],
    ["a UTC offset instead of a zone name", { timezone: "-06:00" }],
    ["a daily limit of 0", { maxAppointmentsPerDay: 0 }],
    ["a daily limit over 100", { maxAppointmentsPerDay: 101 }],
    ["a fractional daily limit", { maxAppointmentsPerDay: 2.5 }],
    ["a negative buffer", { bufferMinutes: -5 }],
    ["a buffer over 2 hours", { bufferMinutes: 125 }],
    ["a buffer not in 5-minute steps", { bufferMinutes: 7 }],
  ])("rejects %s", async (_, body) => {
    expect((await call("PATCH", "/me", pro, body)).statusCode).toBe(400);
  });
});

describe("time off", () => {
  const timeOff = { startDate: "2030-01-07", endDate: "2030-01-11", reason: "Vacation" };
  const create = (body: object, headers = pro) => call("POST", "/me/time-off", headers, body);

  async function bookAppointment(startsAt: string, endsAt: string) {
    const { id: serviceId } = (await call("POST", "/me/services", pro, service)).json();
    const svc = await prisma.service.findUniqueOrThrow({ where: { id: serviceId } });
    const client = await createUser(app, "CLIENT");
    return prisma.appointment.create({
      data: {
        professionalId: svc.professionalId,
        clientId: client.user.id,
        serviceId,
        startsAt: new Date(startsAt),
        endsAt: new Date(endsAt),
      },
    });
  }

  it("creates, lists and deletes time off", async () => {
    const created = await create(timeOff);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({ id: expect.any(String), ...timeOff });

    expect((await call("GET", "/me/time-off", pro)).json()).toEqual([created.json()]);

    expect((await call("DELETE", `/me/time-off/${created.json().id}`, pro)).statusCode).toBe(204);
    expect((await call("GET", "/me/time-off", pro)).json()).toEqual([]);
  });

  it("accepts a single day without a reason", async () => {
    const res = await create({ startDate: "2030-01-07", endDate: "2030-01-07" });

    expect(res.statusCode).toBe(201);
    expect(res.json().reason).toBeNull();
  });

  it("rejects time off that overlaps existing time off", async () => {
    await create(timeOff);
    const res = await create({ startDate: "2030-01-11", endDate: "2030-01-15" });

    expect(res.statusCode).toBe(409);
  });

  it("is blocked by appointments on those days and lists them", async () => {
    const appointment = await bookAppointment("2030-01-09T15:00:00Z", "2030-01-09T15:30:00Z");
    const res = await create(timeOff);

    expect(res.statusCode).toBe(409);
    expect(res.json().appointments).toEqual([
      { id: appointment.id, startsAt: "2030-01-09T15:00:00.000Z", endsAt: "2030-01-09T15:30:00.000Z" },
    ]);
    expect(await prisma.timeOff.count()).toBe(0);
  });

  it("ignores cancelled appointments", async () => {
    const appointment = await bookAppointment("2030-01-09T15:00:00Z", "2030-01-09T15:30:00Z");
    await prisma.appointment.update({ where: { id: appointment.id }, data: { status: "CANCELLED" } });

    expect((await create(timeOff)).statusCode).toBe(201);
  });

  it("checks appointments in the professional's timezone", async () => {
    // 03:00 UTC on Jan 12 is still Jan 11 at 21:00 in Mexico City.
    await bookAppointment("2030-01-12T03:00:00Z", "2030-01-12T03:30:00Z");

    expect((await create(timeOff)).statusCode).toBe(201);
    await prisma.timeOff.deleteMany();

    await call("PATCH", "/me", pro, { timezone: "America/Mexico_City" });
    expect((await create(timeOff)).statusCode).toBe(409);
  });

  it("does not let a professional delete another professional's time off", async () => {
    const { id } = (await create(timeOff)).json();
    const other = (await createUser(app, "PROFESSIONAL")).headers;

    expect((await call("DELETE", `/me/time-off/${id}`, other)).statusCode).toBe(404);
    expect(await prisma.timeOff.count()).toBe(1);
  });

  it.each([
    ["a start date in the past", { startDate: "2020-01-01", endDate: "2030-01-01" }],
    ["an end date before the start date", { startDate: "2030-01-11", endDate: "2030-01-07" }],
    ["a period over 365 days", { startDate: "2030-01-01", endDate: "2031-01-01" }],
    ["an impossible date", { startDate: "2030-02-30", endDate: "2030-03-01" }],
    ["a datetime instead of a date", { startDate: "2030-01-07T00:00:00Z", endDate: "2030-01-08" }],
    ["a non-ISO date", { startDate: "07/01/2030", endDate: "2030-01-08" }],
    ["a missing end date", { startDate: "2030-01-07" }],
    ["an empty reason", { ...timeOff, reason: "   " }],
    ["a reason over 200 characters", { ...timeOff, reason: "a".repeat(201) }],
    ["unknown fields", { ...timeOff, professionalId: "x" }],
  ])("rejects %s", async (_, body) => {
    expect((await create(body)).statusCode).toBe(400);
  });

  it("rejects a malformed time off id", async () => {
    expect((await call("DELETE", "/me/time-off/123", pro)).statusCode).toBe(400);
  });
});

describe("services", () => {
  it("creates, updates and deletes a service", async () => {
    const created = await call("POST", "/me/services", pro, service);
    expect(created.statusCode).toBe(201);
    const { id } = created.json();

    const updated = await call("PATCH", `/me/services/${id}`, pro, { priceCents: 30000 });
    expect(updated.json()).toEqual({ id, ...service, priceCents: 30000 });

    expect((await call("DELETE", `/me/services/${id}`, pro)).statusCode).toBe(204);
    expect(await prisma.service.count()).toBe(0);
  });

  it.each([
    ["an empty name", { ...service, name: "   " }],
    ["a zero duration", { ...service, durationMinutes: 0 }],
    ["a duration not in 5-minute steps", { ...service, durationMinutes: 32 }],
    ["a duration over 8 hours", { ...service, durationMinutes: 485 }],
    ["a negative price", { ...service, priceCents: -1 }],
    ["a fractional price", { ...service, priceCents: 99.5 }],
    ["a price as a string", { ...service, priceCents: "25000" }],
    ["a missing field", { name: "Haircut", durationMinutes: 30 }],
    ["unknown fields", { ...service, professionalId: "someone-else" }],
  ])("rejects a service with %s", async (_, body) => {
    expect((await call("POST", "/me/services", pro, body)).statusCode).toBe(400);
  });

  it("rejects an empty update", async () => {
    const { id } = (await call("POST", "/me/services", pro, service)).json();
    expect((await call("PATCH", `/me/services/${id}`, pro, {})).statusCode).toBe(400);
  });

  it("does not let a professional touch another professional's service", async () => {
    const { id } = (await call("POST", "/me/services", pro, service)).json();
    const other = (await createUser(app, "PROFESSIONAL")).headers;

    expect((await call("PATCH", `/me/services/${id}`, other, { priceCents: 1 })).statusCode).toBe(404);
    expect((await call("DELETE", `/me/services/${id}`, other)).statusCode).toBe(404);
    expect((await prisma.service.findUniqueOrThrow({ where: { id } })).priceCents).toBe(service.priceCents);
  });

  it("refuses to delete a service with appointments", async () => {
    const { id } = (await call("POST", "/me/services", pro, service)).json();
    const svc = await prisma.service.findUniqueOrThrow({ where: { id } });
    const client = await createUser(app, "CLIENT");
    await prisma.appointment.create({
      data: {
        professionalId: svc.professionalId,
        clientId: client.user.id,
        serviceId: id,
        startsAt: new Date("2030-01-07T10:00:00Z"),
        endsAt: new Date("2030-01-07T10:30:00Z"),
      },
    });

    expect((await call("DELETE", `/me/services/${id}`, pro)).statusCode).toBe(409);
  });

  it("rejects a malformed service id", async () => {
    expect((await call("DELETE", "/me/services/123", pro)).statusCode).toBe(400);
  });
});

describe("PUT /me/availability", () => {
  const put = (slots: object[]) => call("PUT", "/me/availability", pro, { slots });

  it("replaces the whole schedule", async () => {
    await put([{ weekday: 1, startMinute: 540, endMinute: 720 }]);
    const res = await put([{ weekday: 3, startMinute: 600, endMinute: 660 }]);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ weekday: 3, startMinute: 600, endMinute: 660 }]);
  });

  it("clears the schedule with an empty list", async () => {
    await put([{ weekday: 1, startMinute: 540, endMinute: 720 }]);
    expect((await put([])).json()).toEqual([]);
  });

  it("accepts adjacent slots and the same hours on different days", async () => {
    const res = await put([
      { weekday: 1, startMinute: 540, endMinute: 720 },
      { weekday: 1, startMinute: 720, endMinute: 900 },
      { weekday: 2, startMinute: 540, endMinute: 720 },
      { weekday: 6, startMinute: 0, endMinute: 1440 },
    ]);

    expect(res.statusCode).toBe(200);
  });

  it("rejects overlapping slots on the same day and keeps the old schedule", async () => {
    await put([{ weekday: 1, startMinute: 540, endMinute: 720 }]);
    const res = await put([
      { weekday: 1, startMinute: 540, endMinute: 720 },
      { weekday: 1, startMinute: 700, endMinute: 800 },
    ]);

    expect(res.statusCode).toBe(400);
    expect(res.json().issues[0].path).toEqual(["slots", 1]);
    expect(await prisma.availability.count()).toBe(1);
  });

  it.each([
    ["end before start", { weekday: 1, startMinute: 720, endMinute: 540 }],
    ["zero length", { weekday: 1, startMinute: 540, endMinute: 540 }],
    ["weekday 7", { weekday: 7, startMinute: 540, endMinute: 720 }],
    ["a negative weekday", { weekday: -1, startMinute: 540, endMinute: 720 }],
    ["minutes past midnight", { weekday: 1, startMinute: 540, endMinute: 1445 }],
    ["minutes not in 5-minute steps", { weekday: 1, startMinute: 541, endMinute: 720 }],
    ["a missing field", { weekday: 1, startMinute: 540 }],
    ["unknown fields", { weekday: 1, startMinute: 540, endMinute: 720, note: "x" }],
  ])("rejects a slot with %s", async (_, slot) => {
    expect((await put([slot])).statusCode).toBe(400);
  });

  it("rejects more than 50 slots", async () => {
    const slots = Array.from({ length: 51 }, (_, i) => ({
      weekday: i % 7,
      startMinute: Math.floor(i / 7) * 60,
      endMinute: Math.floor(i / 7) * 60 + 30,
    }));
    expect((await put(slots)).statusCode).toBe(400);
  });
});
