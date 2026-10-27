import type { User } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createUser } from "../../test/auth.js";
import { resetDb } from "../../test/db.js";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import type { Notification, Recipient } from "../notifications/notifier.js";

const sent: (Notification & { to: Recipient })[] = [];
const app = buildApp({ notifier: { notify: async (to, notification) => void sent.push({ to, ...notification }) } });

// Tuesday 2030-01-01 06:00 in Mexico City. The professional works Mondays 09:00-11:00.
const NOW = new Date("2030-01-01T12:00:00Z");
const MONDAY_9AM = "2030-01-07T15:00:00.000Z";
const MONDAY_10AM = "2030-01-07T16:00:00.000Z";

let professional: { id: string; user: User; headers: Record<string, string> };
let client: { user: User; headers: Record<string, string> };
let serviceId: string;

// Tokens expire after 1h, so tests that move the clock sign a fresh one.
const headersFor = (user: User) => ({ authorization: `Bearer ${app.jwt.sign({ sub: user.id, role: user.role })}` });

function book(payload: object, headers = client.headers) {
  return app.inject({ method: "POST", url: "/appointments", headers, payload });
}

function bookAt(startsAt: string, headers = client.headers) {
  return book({ professionalId: professional.id, serviceId, startsAt }, headers);
}

function cancel(id: string, headers: Record<string, string>) {
  return app.inject({ method: "POST", url: `/appointments/${id}/cancel`, headers });
}

function list(headers: Record<string, string>, query: Record<string, string> = {}) {
  return app.inject({ method: "GET", url: "/appointments/me", headers, query });
}

async function slotTimes() {
  const res = await app.inject({
    method: "GET",
    url: `/professionals/${professional.id}/slots`,
    query: { serviceId, date: "2030-01-07" },
  });
  return res.json().slots.map((slot: { localTime: string }) => slot.localTime);
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  await resetDb();
  sent.length = 0;

  const pro = await createUser(app, "PROFESSIONAL");
  professional = { id: pro.professionalId!, user: pro.user, headers: pro.headers };
  client = await createUser(app, "CLIENT");

  const asPro = (method: "PATCH" | "PUT" | "POST", url: string, payload: object) =>
    app.inject({ method, url: `/professionals/me${url}`, headers: professional.headers, payload });
  await asPro("PATCH", "", { timezone: "America/Mexico_City" });
  await asPro("PUT", "/availability", { slots: [{ weekday: 1, startMinute: 540, endMinute: 660 }] });
  serviceId = (await asPro("POST", "/services", { name: "Haircut", durationMinutes: 60, priceCents: 25000 })).json().id;
});

afterAll(async () => {
  vi.useRealTimers();
  await app.close();
  await prisma.$disconnect();
});

describe("POST /appointments", () => {
  it("books a free slot and notifies both parties", async () => {
    const res = await bookAt(MONDAY_9AM);

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      id: expect.any(String),
      status: "CONFIRMED",
      startsAt: MONDAY_9AM,
      endsAt: MONDAY_10AM,
      cancelledAt: null,
      cancelledBy: null,
      service: { id: serviceId, name: "Haircut", durationMinutes: 60, priceCents: 25000 },
      professional: { id: professional.id, name: "Test professional", timezone: "America/Mexico_City" },
      client: { id: client.user.id, name: "Test client" },
    });
    expect(JSON.stringify(res.json())).not.toContain("@example.com");

    expect(sent.map((n) => n.to.email).sort()).toEqual([client.user.email, professional.user.email].sort());
    expect(sent[0].text).toContain("2030-01-07 09:00 (America/Mexico_City)");
  });

  it("accepts the same instant written with a local offset", async () => {
    expect((await bookAt("2030-01-07T09:00:00-06:00")).statusCode).toBe(201);
  });

  it("removes the booked time from the available slots", async () => {
    await bookAt(MONDAY_9AM);
    expect(await slotTimes()).toEqual(["10:00"]);
  });

  it("lets only one of two simultaneous requests for the same time succeed", async () => {
    const other = await createUser(app, "CLIENT");
    const results = await Promise.all([bookAt(MONDAY_9AM), bookAt(MONDAY_9AM, other.headers)]);

    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(await prisma.appointment.count()).toBe(1);
  });

  it("lets only one of two simultaneous overlapping requests succeed", async () => {
    const other = await createUser(app, "CLIENT");
    const results = await Promise.all([bookAt(MONDAY_9AM), bookAt("2030-01-07T15:30:00Z", other.headers)]);

    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
  });

  it.each([
    ["a time off the 15-minute grid", "2030-01-07T15:05:00Z"],
    ["a time outside working hours", "2030-01-07T14:00:00Z"],
    ["a service that would end after working hours", "2030-01-07T16:15:00Z"],
    ["a day without availability", "2030-01-08T15:00:00Z"],
    ["a time in the past", "2029-12-31T15:00:00Z"],
    ["a time beyond the 60-day window", "2030-03-04T15:00:00Z"],
  ])("rejects %s with 409", async (_, startsAt) => {
    expect((await bookAt(startsAt)).statusCode).toBe(409);
  });

  it("rejects a time that is already booked", async () => {
    await bookAt(MONDAY_9AM);
    expect((await bookAt("2030-01-07T15:30:00Z")).statusCode).toBe(409);
  });

  it("returns 404 for an unknown professional or a service of another professional", async () => {
    const other = await createUser(app, "PROFESSIONAL");
    const unknown = "00000000-0000-4000-8000-000000000000";

    expect((await book({ professionalId: unknown, serviceId, startsAt: MONDAY_9AM })).statusCode).toBe(404);
    expect((await book({ professionalId: other.professionalId, serviceId, startsAt: MONDAY_9AM })).statusCode).toBe(404);
  });

  it.each([
    ["a datetime without offset", { startsAt: "2030-01-07T15:00:00" }],
    ["a date only", { startsAt: "2030-01-07" }],
    ["a malformed service id", { serviceId: "abc" }],
    ["a missing professional id", { professionalId: undefined }],
    ["unknown fields", { clientId: "someone-else" }],
  ])("rejects %s with 400", async (_, overrides) => {
    expect((await book({ professionalId: professional.id, serviceId, startsAt: MONDAY_9AM, ...overrides })).statusCode).toBe(400);
  });

  it("only lets clients book", async () => {
    expect((await bookAt(MONDAY_9AM, professional.headers)).statusCode).toBe(403);
    expect((await bookAt(MONDAY_9AM, {})).statusCode).toBe(401);
  });
});

describe("GET /appointments/me", () => {
  it("shows clients only their own appointments and professionals theirs", async () => {
    const other = await createUser(app, "CLIENT");
    await bookAt(MONDAY_9AM);
    await bookAt(MONDAY_10AM, other.headers);

    const mine = (await list(client.headers)).json();
    expect(mine.map((a: { startsAt: string }) => a.startsAt)).toEqual([MONDAY_9AM]);

    const pro = (await list(professional.headers)).json();
    expect(pro.map((a: { startsAt: string }) => a.startsAt)).toEqual([MONDAY_9AM, MONDAY_10AM]);
  });

  it("separates upcoming and past appointments", async () => {
    await bookAt(MONDAY_9AM);
    expect((await list(client.headers, { scope: "past" })).json()).toEqual([]);

    vi.setSystemTime(new Date("2030-01-08T00:00:00Z"));
    const headers = headersFor(client.user);
    expect((await list(headers)).json()).toEqual([]);
    expect((await list(headers, { scope: "past" })).json()).toHaveLength(1);
  });

  it("paginates", async () => {
    const other = await createUser(app, "CLIENT");
    await bookAt(MONDAY_9AM);
    await bookAt(MONDAY_10AM, other.headers);

    const page = (await list(professional.headers, { limit: "1", offset: "1" })).json();
    expect(page.map((a: { startsAt: string }) => a.startsAt)).toEqual([MONDAY_10AM]);
  });

  it.each([
    ["an unknown scope", { scope: "all" }],
    ["a limit of 0", { limit: "0" }],
    ["a limit over 100", { limit: "101" }],
    ["a non-numeric limit", { limit: "ten" }],
    ["a negative offset", { offset: "-1" }],
    ["unknown parameters", { status: "CONFIRMED" }],
  ])("rejects %s", async (_, query) => {
    expect((await list(client.headers, query)).statusCode).toBe(400);
  });

  it("requires a token", async () => {
    expect((await list({})).statusCode).toBe(401);
  });
});

describe("POST /appointments/:id/cancel", () => {
  let appointmentId: string;

  beforeEach(async () => {
    appointmentId = (await bookAt(MONDAY_9AM)).json().id;
    sent.length = 0;
  });

  it("lets a client cancel 48 hours or more in advance and notifies the professional", async () => {
    const res = await cancel(appointmentId, client.headers);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "CANCELLED", cancelledBy: "CLIENT", cancelledAt: NOW.toISOString() });
    expect(sent).toHaveLength(1);
    expect(sent[0].to.email).toBe(professional.user.email);
    expect(await slotTimes()).toHaveLength(5);
  });

  it("blocks a client from cancelling less than 48 hours before", async () => {
    vi.setSystemTime(new Date("2030-01-05T16:00:00Z")); // 47h before
    const res = await cancel(appointmentId, headersFor(client.user));

    expect(res.statusCode).toBe(403);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId } })).status).toBe("CONFIRMED");
  });

  it("allows a client to cancel exactly 48 hours before", async () => {
    vi.setSystemTime(new Date("2030-01-05T15:00:00Z"));
    expect((await cancel(appointmentId, headersFor(client.user))).statusCode).toBe(200);
  });

  it("lets the professional cancel at any time before the appointment and notifies the client", async () => {
    vi.setSystemTime(new Date("2030-01-07T14:00:00Z")); // 1h before
    const res = await cancel(appointmentId, headersFor(professional.user));

    expect(res.statusCode).toBe(200);
    expect(res.json().cancelledBy).toBe("PROFESSIONAL");
    expect(sent[0].to.email).toBe(client.user.email);
  });

  it("rejects cancelling an appointment that already started", async () => {
    vi.setSystemTime(new Date("2030-01-07T15:10:00Z"));
    expect((await cancel(appointmentId, headersFor(professional.user))).statusCode).toBe(409);
  });

  it("rejects cancelling twice", async () => {
    await cancel(appointmentId, client.headers);
    expect((await cancel(appointmentId, client.headers)).statusCode).toBe(409);
  });

  it("returns 404 for someone else's appointment", async () => {
    const otherClient = await createUser(app, "CLIENT");
    const otherPro = await createUser(app, "PROFESSIONAL");

    expect((await cancel(appointmentId, otherClient.headers)).statusCode).toBe(404);
    expect((await cancel(appointmentId, otherPro.headers)).statusCode).toBe(404);
  });

  it("rejects a malformed id", async () => {
    expect((await cancel("123", client.headers)).statusCode).toBe(400);
  });
});
