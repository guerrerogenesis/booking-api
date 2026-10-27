import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createUser } from "../../test/auth.js";
import { resetDb } from "../../test/db.js";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { computeSlots } from "./slots.js";

describe("computeSlots", () => {
  const base: Parameters<typeof computeSlots>[0] = {
    date: "2030-01-07",
    timeZone: "UTC",
    blocks: [{ startMinute: 540, endMinute: 660 }], // 09:00-11:00
    durationMinutes: 60,
    bufferMinutes: 0,
    appointments: [],
    notBefore: new Date("2030-01-01T00:00:00Z"),
  };
  const at = (time: string) => new Date(`2030-01-07T${time}:00Z`);
  const times = (input: Partial<typeof base>) =>
    computeSlots({ ...base, ...input }).map((slot) => slot.localTime);

  it("offers every 15 minutes where the service fits inside the block", () => {
    expect(times({})).toEqual(["09:00", "09:15", "09:30", "09:45", "10:00"]);
  });

  it("returns nothing when the service is longer than the block", () => {
    expect(times({ durationMinutes: 180 })).toEqual([]);
  });

  it("lets a service span adjacent blocks", () => {
    const blocks = [
      { startMinute: 600, endMinute: 660 },
      { startMinute: 540, endMinute: 600 },
    ];
    expect(times({ blocks, durationMinutes: 120 })).toEqual(["09:00"]);
  });

  it("keeps separate blocks separate", () => {
    const blocks = [
      { startMinute: 540, endMinute: 600 },
      { startMinute: 840, endMinute: 900 },
    ];
    expect(times({ blocks })).toEqual(["09:00", "14:00"]);
  });

  it("skips times that clash with an appointment", () => {
    const appointments = [{ startsAt: at("09:30"), endsAt: at("10:00") }];
    expect(times({ appointments })).toEqual(["10:00"]);
  });

  it("keeps the buffer before and after appointments", () => {
    const appointments = [{ startsAt: at("10:00"), endsAt: at("10:30") }];
    const blocks = [{ startMinute: 480, endMinute: 720 }]; // 08:00-12:00

    expect(times({ appointments, blocks, bufferMinutes: 0 })).toEqual(["08:00", "08:15", "08:30", "08:45", "09:00", "10:30", "10:45", "11:00"]);
    expect(times({ appointments, blocks, bufferMinutes: 15 })).toEqual(["08:00", "08:15", "08:30", "08:45", "10:45", "11:00"]);
  });

  it("skips times before notBefore", () => {
    expect(times({ notBefore: at("09:20") })).toEqual(["09:30", "09:45", "10:00"]);
  });

  it("returns UTC instants for the professional's local times", () => {
    const [first] = computeSlots({ ...base, timeZone: "America/Mexico_City" });

    expect(first.localTime).toBe("09:00");
    expect(first.startsAt.toISOString()).toBe("2030-01-07T15:00:00.000Z");
    expect(first.endsAt.toISOString()).toBe("2030-01-07T16:00:00.000Z");
  });
});

describe("GET /professionals/:id/slots", () => {
  const app = buildApp();
  // Tuesday 2030-01-01 06:00 in Mexico City.
  const NOW = new Date("2030-01-01T12:00:00Z");
  const MONDAY = "2030-01-07";

  let professionalId: string;
  let serviceId: string;
  let headers: Record<string, string>;

  const getSlots = (query: Record<string, string>, id = professionalId) =>
    app.inject({ method: "GET", url: `/professionals/${id}/slots`, query });
  const localTimes = async (query: Record<string, string>) =>
    (await getSlots(query)).json().slots.map((slot: { localTime: string }) => slot.localTime);

  async function book(startsAt: string, endsAt: string) {
    const client = await createUser(app, "CLIENT");
    await prisma.appointment.create({
      data: { professionalId, clientId: client.user.id, serviceId, startsAt: new Date(startsAt), endsAt: new Date(endsAt) },
    });
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    await resetDb();

    const pro = await createUser(app, "PROFESSIONAL");
    professionalId = pro.professionalId!;
    headers = pro.headers;
    const patch = (url: string, payload: object, method: "PATCH" | "PUT" = "PATCH") =>
      app.inject({ method, url: `/professionals/me${url}`, headers, payload });

    await patch("", { timezone: "America/Mexico_City" });
    await patch(
      "/availability",
      {
        slots: [
          { weekday: 1, startMinute: 540, endMinute: 660 }, // Monday 09:00-11:00
          { weekday: 2, startMinute: 420, endMinute: 600 }, // Tuesday 07:00-10:00
        ],
      },
      "PUT",
    );
    const res = await app.inject({
      method: "POST",
      url: "/professionals/me/services",
      headers,
      payload: { name: "Haircut", durationMinutes: 60, priceCents: 25000 },
    });
    serviceId = res.json().id;
  });

  afterAll(async () => {
    vi.useRealTimers();
    await app.close();
    await prisma.$disconnect();
  });

  it("returns the free slots in UTC with local times", async () => {
    const res = await getSlots({ serviceId, date: MONDAY });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ date: MONDAY, timezone: "America/Mexico_City", durationMinutes: 60 });
    expect(res.json().slots[0]).toEqual({
      startsAt: "2030-01-07T15:00:00.000Z",
      endsAt: "2030-01-07T16:00:00.000Z",
      localTime: "09:00",
    });
    expect(res.json().slots).toHaveLength(5);
  });

  it("requires 2 hours of notice for today", async () => {
    // It's 06:00 locally, so the earliest bookable start is 08:00.
    expect(await localTimes({ serviceId, date: "2030-01-01" })).toEqual(["08:00", "08:15", "08:30", "08:45", "09:00"]);
  });

  it("returns no slots on a day without availability", async () => {
    expect(await localTimes({ serviceId, date: "2030-01-09" })).toEqual([]);
  });

  it("excludes booked times and applies the buffer", async () => {
    await book("2030-01-07T15:30:00Z", "2030-01-07T16:00:00Z"); // 09:30-10:00 local
    expect(await localTimes({ serviceId, date: MONDAY })).toEqual(["10:00"]);

    await app.inject({ method: "PATCH", url: "/professionals/me", headers, payload: { bufferMinutes: 15 } });
    expect(await localTimes({ serviceId, date: MONDAY })).toEqual([]);
  });

  it("ignores cancelled appointments", async () => {
    await book("2030-01-07T15:30:00Z", "2030-01-07T16:00:00Z");
    await prisma.appointment.updateMany({ data: { status: "CANCELLED" } });

    expect(await localTimes({ serviceId, date: MONDAY })).toHaveLength(5);
  });

  it("returns no slots on time off", async () => {
    await app.inject({
      method: "POST",
      url: "/professionals/me/time-off",
      headers,
      payload: { startDate: MONDAY, endDate: MONDAY },
    });

    expect(await localTimes({ serviceId, date: MONDAY })).toEqual([]);
  });

  it("returns no slots once the daily limit is reached", async () => {
    await app.inject({ method: "PATCH", url: "/professionals/me", headers, payload: { maxAppointmentsPerDay: 1 } });
    await book("2030-01-07T15:00:00Z", "2030-01-07T15:30:00Z");

    expect(await localTimes({ serviceId, date: MONDAY })).toEqual([]);
  });

  it("counts the daily limit in local time", async () => {
    await app.inject({ method: "PATCH", url: "/professionals/me", headers, payload: { maxAppointmentsPerDay: 1 } });
    // Monday 03:00 UTC is still Sunday evening in Mexico City.
    await book("2030-01-07T03:00:00Z", "2030-01-07T03:30:00Z");

    expect(await localTimes({ serviceId, date: MONDAY })).toHaveLength(5);
  });

  it("returns 404 for an unknown professional or a service of another professional", async () => {
    const other = await createUser(app, "PROFESSIONAL");

    expect((await getSlots({ serviceId, date: MONDAY }, "00000000-0000-4000-8000-000000000000")).statusCode).toBe(404);
    expect((await getSlots({ serviceId, date: MONDAY }, other.professionalId)).statusCode).toBe(404);
  });

  it.each([
    ["a date in the past", { date: "2029-12-31" }],
    ["a date beyond 60 days", { date: "2030-03-03" }],
    ["a malformed date", { date: "07-01-2030" }],
    ["a malformed service id", { serviceId: "abc" }],
    ["unknown query parameters", { extra: "1" }],
  ])("rejects %s", async (_, overrides) => {
    expect((await getSlots({ serviceId, date: MONDAY, ...overrides })).statusCode).toBe(400);
  });

  it("rejects a missing service id", async () => {
    expect((await getSlots({ date: MONDAY })).statusCode).toBe(400);
  });
});
