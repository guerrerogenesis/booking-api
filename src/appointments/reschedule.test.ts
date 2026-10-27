import type { User } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createUser } from "../../test/auth.js";
import { resetDb } from "../../test/db.js";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import type { Notification, Recipient } from "../notifications/notifier.js";

const sent: (Notification & { to: Recipient })[] = [];
const app = buildApp({ notifier: { notify: async (to, notification) => void sent.push({ to, ...notification }) } });

// Tuesday 2030-01-01 06:00 in Mexico City. The professional works Monday and Wednesday 09:00-13:00.
const NOW = new Date("2030-01-01T12:00:00Z");
const MONDAY_9AM = "2030-01-07T15:00:00.000Z";
const MONDAY_930AM = "2030-01-07T15:30:00.000Z";
const MONDAY_11AM = "2030-01-07T17:00:00.000Z";
const WEDNESDAY_9AM = "2030-01-09T15:00:00.000Z";

type Headers = Record<string, string>;
let pro: { user: User; headers: Headers };
let client: { user: User; headers: Headers };
let serviceId: string;
let appointmentId: string;

// Tokens expire after 1h, so tests that move the clock sign a fresh one.
const headersFor = (user: User) => ({ authorization: `Bearer ${app.jwt.sign({ sub: user.id, role: user.role })}` });

function post(url: string, headers: Headers, payload?: object) {
  return app.inject({ method: "POST", url: `/appointments/${appointmentId}${url}`, headers, payload });
}

const requestChange = (startsAt: string, headers = client.headers) =>
  post("/reschedule-requests", headers, { startsAt });
const respond = (requestId: string, action: "accept" | "reject" | "withdraw", headers: Headers, payload?: object) =>
  post(`/reschedule-requests/${requestId}/${action}`, headers, payload);

async function appointmentStart() {
  return (await prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId } })).startsAt.toISOString();
}

async function bookAs(headers: Headers, startsAt: string) {
  const professionalId = (await prisma.professional.findUniqueOrThrow({ where: { userId: pro.user.id } })).id;
  return app.inject({ method: "POST", url: "/appointments", headers, payload: { professionalId, serviceId, startsAt } });
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  await resetDb();

  pro = await createUser(app, "PROFESSIONAL");
  client = await createUser(app, "CLIENT");
  const asPro = (method: "PATCH" | "PUT" | "POST", url: string, payload: object) =>
    app.inject({ method, url: `/professionals/me${url}`, headers: pro.headers, payload });
  await asPro("PATCH", "", { timezone: "America/Mexico_City" });
  await asPro("PUT", "/availability", {
    slots: [
      { weekday: 1, startMinute: 540, endMinute: 780 },
      { weekday: 3, startMinute: 540, endMinute: 780 },
    ],
  });
  serviceId = (await asPro("POST", "/services", { name: "Haircut", durationMinutes: 60, priceCents: 25000 })).json().id;
  appointmentId = (await bookAs(client.headers, MONDAY_9AM)).json().id;
  sent.length = 0;
});

afterAll(async () => {
  vi.useRealTimers();
  await app.close();
  await prisma.$disconnect();
});

describe("client requests a change", () => {
  it("creates a pending request, notifies the professional and keeps the appointment as is", async () => {
    const res = await requestChange(WEDNESDAY_9AM);

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: "PENDING", startsAt: WEDNESDAY_9AM, endsAt: "2030-01-09T16:00:00.000Z" });
    expect(await appointmentStart()).toBe(MONDAY_9AM);
    expect(sent).toHaveLength(1);
    expect(sent[0].to.email).toBe(pro.user.email);
    expect(sent[0].text).toContain("2030-01-09 09:00");

    const [listed] = (await app.inject({ method: "GET", url: "/appointments/me", headers: client.headers })).json();
    expect(listed.pendingReschedule).toMatchObject({ id: res.json().id, status: "PENDING" });
  });

  it("allows a new time that overlaps the appointment's own current time", async () => {
    expect((await requestChange(MONDAY_930AM)).statusCode).toBe(201);
  });

  it("allows only one pending request per appointment", async () => {
    await requestChange(WEDNESDAY_9AM);
    expect((await requestChange(MONDAY_11AM)).statusCode).toBe(409);
  });

  it("lets only one of two simultaneous requests succeed", async () => {
    const results = await Promise.all([requestChange(WEDNESDAY_9AM), requestChange(MONDAY_11AM)]);

    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(await prisma.rescheduleRequest.count({ where: { status: "PENDING" } })).toBe(1);
  });

  it("requires 48 hours of notice", async () => {
    vi.setSystemTime(new Date("2030-01-05T16:00:00Z")); // 47h before
    expect((await requestChange(WEDNESDAY_9AM, headersFor(client.user))).statusCode).toBe(403);
  });

  it("rejects a time booked by someone else", async () => {
    await bookAs((await createUser(app, "CLIENT")).headers, MONDAY_11AM);
    expect((await requestChange(MONDAY_11AM)).statusCode).toBe(409);
  });

  it.each([
    ["a time outside working hours", "2030-01-07T20:00:00Z"],
    ["a day without availability", "2030-01-08T15:00:00Z"],
  ])("rejects %s", async (_, startsAt) => {
    expect((await requestChange(startsAt)).statusCode).toBe(409);
  });

  it("rejects the current time", async () => {
    expect((await requestChange(MONDAY_9AM)).statusCode).toBe(400);
  });

  it.each([
    ["a datetime without offset", { startsAt: "2030-01-09T15:00:00" }],
    ["a missing startsAt", {}],
    ["unknown fields", { startsAt: WEDNESDAY_9AM, status: "ACCEPTED" }],
  ])("rejects %s", async (_, body) => {
    expect((await post("/reschedule-requests", client.headers, body)).statusCode).toBe(400);
  });

  it("rejects requests on a cancelled appointment", async () => {
    await post("/cancel", client.headers);
    expect((await requestChange(WEDNESDAY_9AM)).statusCode).toBe(409);
  });

  it("only lets the appointment's client request changes", async () => {
    const other = await createUser(app, "CLIENT");
    expect((await requestChange(WEDNESDAY_9AM, other.headers)).statusCode).toBe(404);
    expect((await requestChange(WEDNESDAY_9AM, pro.headers)).statusCode).toBe(403);
  });
});

describe("professional answers a request", () => {
  let requestId: string;

  beforeEach(async () => {
    requestId = (await requestChange(WEDNESDAY_9AM)).json().id;
    sent.length = 0;
  });

  it("accepting moves the appointment and notifies the client", async () => {
    const res = await respond(requestId, "accept", pro.headers);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ startsAt: WEDNESDAY_9AM, pendingReschedule: null });
    expect(await appointmentStart()).toBe(WEDNESDAY_9AM);
    expect((await prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: requestId } })).status).toBe("ACCEPTED");
    expect(sent[0].to.email).toBe(client.user.email);
    expect(sent[0].text).toContain("from 2030-01-07 09:00");

    // The old time is free again.
    expect((await bookAs((await createUser(app, "CLIENT")).headers, MONDAY_9AM)).statusCode).toBe(201);
  });

  it("can't accept when the requested time was booked in the meantime", async () => {
    await bookAs((await createUser(app, "CLIENT")).headers, WEDNESDAY_9AM);
    const res = await respond(requestId, "accept", pro.headers);

    expect(res.statusCode).toBe(409);
    expect(await appointmentStart()).toBe(MONDAY_9AM);
    expect((await prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: requestId } })).status).toBe("PENDING");
  });

  it("can't accept twice", async () => {
    await respond(requestId, "accept", pro.headers);
    expect((await respond(requestId, "accept", pro.headers)).statusCode).toBe(409);
  });

  it("rejecting keeps the appointment and tells the client why", async () => {
    const res = await respond(requestId, "reject", pro.headers, { reason: "Fully booked that day" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "REJECTED", rejectionReason: "Fully booked that day" });
    expect(await appointmentStart()).toBe(MONDAY_9AM);
    expect(sent[0].text).toContain("Reason: Fully booked that day");
  });

  it("rejecting without a reason is allowed", async () => {
    expect((await respond(requestId, "reject", pro.headers)).statusCode).toBe(200);
  });

  it.each([
    ["an empty reason", { reason: "  " }],
    ["a reason over 200 characters", { reason: "a".repeat(201) }],
    ["unknown fields", { note: "x" }],
  ])("rejects %s", async (_, body) => {
    expect((await respond(requestId, "reject", pro.headers, body)).statusCode).toBe(400);
  });

  it("expires the request once fewer than 48 hours remain", async () => {
    vi.setSystemTime(new Date("2030-01-05T16:00:00Z"));
    const headers = headersFor(pro.user);

    expect((await respond(requestId, "accept", headers)).statusCode).toBe(409);
    const [request] = (await app.inject({ method: "GET", url: `/appointments/${appointmentId}/reschedule-requests`, headers })).json();
    expect(request.status).toBe("EXPIRED");
    expect(await appointmentStart()).toBe(MONDAY_9AM);
  });

  it("is only possible for the appointment's professional", async () => {
    const other = await createUser(app, "PROFESSIONAL");
    expect((await respond(requestId, "accept", other.headers)).statusCode).toBe(404);
    expect((await respond(requestId, "accept", client.headers)).statusCode).toBe(403);
  });

  it("rejects malformed ids", async () => {
    expect((await respond("123", "accept", pro.headers)).statusCode).toBe(400);
  });
});

describe("client withdraws a request", () => {
  it("withdraws the pending request so a new one can be made", async () => {
    const { id } = (await requestChange(WEDNESDAY_9AM)).json();

    const res = await respond(id, "withdraw", client.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("WITHDRAWN");
    expect((await requestChange(MONDAY_11AM)).statusCode).toBe(201);
  });

  it("can't withdraw an answered request or someone else's", async () => {
    const { id } = (await requestChange(WEDNESDAY_9AM)).json();
    const other = await createUser(app, "CLIENT");

    expect((await respond(id, "withdraw", other.headers)).statusCode).toBe(404);
    await respond(id, "reject", pro.headers);
    expect((await respond(id, "withdraw", client.headers)).statusCode).toBe(404);
  });
});

describe("GET /appointments/:id/reschedule-requests", () => {
  it("shows the history to both parties, newest first", async () => {
    const first = (await requestChange(WEDNESDAY_9AM)).json();
    await respond(first.id, "withdraw", client.headers);
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    const second = (await requestChange(MONDAY_11AM, headersFor(client.user))).json();

    for (const user of [client.user, pro.user]) {
      const res = await app.inject({
        method: "GET",
        url: `/appointments/${appointmentId}/reschedule-requests`,
        headers: headersFor(user),
      });
      expect(res.json().map((r: { id: string }) => r.id)).toEqual([second.id, first.id]);
    }
  });

  it("returns 404 to other users", async () => {
    const other = await createUser(app, "CLIENT");
    const res = await app.inject({
      method: "GET",
      url: `/appointments/${appointmentId}/reschedule-requests`,
      headers: other.headers,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("professional moves an appointment directly", () => {
  const move = (startsAt: string, headers = pro.headers) => post("/reschedule", headers, { startsAt });

  it("moves it even with less than 48 hours left and notifies the client", async () => {
    vi.setSystemTime(new Date("2030-01-07T12:00:00Z")); // 3h before
    const res = await move(MONDAY_11AM, headersFor(pro.user));

    expect(res.statusCode).toBe(200);
    expect(res.json().startsAt).toBe(MONDAY_11AM);
    expect(sent[0].to.email).toBe(client.user.email);
    expect(sent[0].text).toContain("from 2030-01-07 09:00");
  });

  it("closes a pending client request", async () => {
    const { id } = (await requestChange(WEDNESDAY_9AM)).json();
    await move(MONDAY_11AM);

    expect((await prisma.rescheduleRequest.findUniqueOrThrow({ where: { id } })).status).toBe("CANCELLED");
  });

  it("rejects an unavailable time", async () => {
    await bookAs((await createUser(app, "CLIENT")).headers, MONDAY_11AM);
    expect((await move(MONDAY_11AM)).statusCode).toBe(409);
    expect(await appointmentStart()).toBe(MONDAY_9AM);
  });

  it("rejects moving an appointment that already started", async () => {
    vi.setSystemTime(new Date("2030-01-07T15:10:00Z"));
    expect((await move(MONDAY_11AM, headersFor(pro.user))).statusCode).toBe(409);
  });

  it("is only possible for the appointment's professional", async () => {
    const other = await createUser(app, "PROFESSIONAL");
    expect((await move(MONDAY_11AM, other.headers)).statusCode).toBe(404);
    expect((await move(MONDAY_11AM, client.headers)).statusCode).toBe(403);
  });
});

describe("cancelling an appointment", () => {
  it("closes its pending request", async () => {
    const { id } = (await requestChange(WEDNESDAY_9AM)).json();
    await post("/cancel", client.headers);

    expect((await prisma.rescheduleRequest.findUniqueOrThrow({ where: { id } })).status).toBe("CANCELLED");
  });
});
