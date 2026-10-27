import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { resetDb } from "../test/db.js";
import { buildApp } from "./app.js";
import { prisma } from "./db.js";
import {
  appointmentResponse,
  availabilityResponse,
  errorResponse,
  healthResponse,
  messageResponse,
  profileResponse,
  rescheduleRequestResponse,
  resetTokenResponse,
  serviceResponse,
  slotsResponse,
  timeOffResponse,
  tokenResponse,
  userResponse,
} from "./docs.js";
import type { Notification } from "./notifications/notifier.js";

const sent: Notification[] = [];
const app = buildApp({ notifier: { notify: async (_, notification) => void sent.push(notification) } });

type Operation = { responses: Record<string, unknown>; operationId?: string; summary?: string; tags?: string[] };
let spec: { openapi: string; paths: Record<string, Record<string, Operation>> };

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2030-01-01T12:00:00Z")); // Tuesday
  await resetDb();
  spec = (await app.inject({ method: "GET", url: "/docs/json" })).json();
});

afterAll(async () => {
  vi.useRealTimers();
  await app.close();
  await prisma.$disconnect();
});

// "/appointments/{id}/cancel" matches "/appointments/<uuid>/cancel". Like Fastify, static
// paths win over parametric ones ("/professionals/me" before "/professionals/{id}").
function findOperation(method: string, url: string): Operation {
  const path = url.split("?")[0];
  const paramCount = (p: string) => (p.match(/\{/g) ?? []).length;
  const template = Object.keys(spec.paths)
    .filter((p) => spec.paths[p][method.toLowerCase()])
    .filter((p) => new RegExp(`^${p.replace(/\{[^}]+\}/g, "[^/]+")}$`).test(path))
    .sort((a, b) => paramCount(a) - paramCount(b))[0];
  const operation = template && spec.paths[template][method.toLowerCase()];
  if (!operation) throw new Error(`${method} ${path} is not in the OpenAPI spec`);
  return operation;
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

// Sends a request and checks that the status is documented for that route and the body
// matches the documented (strict) schema, so undocumented or leaked fields fail the test.
async function call(
  method: Method,
  url: string,
  options: { token?: string; payload?: object; status: number; schema: z.ZodType | null },
) {
  const res: LightMyRequestResponse = await app.inject({
    method,
    url,
    payload: options.payload,
    headers: options.token ? { authorization: `Bearer ${options.token}` } : {},
  });
  expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(options.status);
  expect(Object.keys(findOperation(method, url).responses), `${method} ${url}`).toContain(String(res.statusCode));

  if (options.schema === null) {
    expect(res.body).toBe("");
    return undefined;
  }
  const result = options.schema.safeParse(res.json());
  expect(result.error?.issues, `${method} ${url} doesn't match its documented schema`).toBeUndefined();
  return res.json();
}

describe("OpenAPI spec", () => {
  it("documents every route with a unique operationId, a summary and a success response", () => {
    const operations = Object.values(spec.paths).flatMap((methods) => Object.values(methods));

    expect(spec.openapi).toBe("3.1.0");
    expect(operations).toHaveLength(27);
    const ids = operations.map((op) => op.operationId);
    expect(new Set(ids).size).toBe(operations.length);
    for (const op of operations) {
      expect(op.summary, op.operationId).toBeTruthy();
      expect(op.tags, op.operationId).toHaveLength(1);
      expect(Object.keys(op.responses).some((status) => status.startsWith("2")), op.operationId).toBe(true);
    }
  });

  it("serves the Swagger UI", async () => {
    const res = await app.inject({ method: "GET", url: "/docs/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
  });
});

describe("responses match the documented schemas", () => {
  it("across the whole booking flow", async () => {
    await call("GET", "/health", { status: 200, schema: healthResponse });

    // Accounts
    const proUser = await call("POST", "/auth/register", {
      payload: { email: "pro@example.com", password: "Sup3r$ecret", name: "Pro", role: "PROFESSIONAL" },
      status: 201,
      schema: userResponse,
    });
    await call("POST", "/auth/register", {
      payload: { email: "client@example.com", password: "Sup3r$ecret", name: "Client" },
      status: 201,
      schema: userResponse,
    });
    const login = (email: string) =>
      call("POST", "/auth/login", { payload: { email, password: "Sup3r$ecret" }, status: 200, schema: tokenResponse });
    const pro: string = (await login("pro@example.com")).token;
    const client: string = (await login("client@example.com")).token;
    await call("GET", "/auth/me", { token: client, status: 200, schema: userResponse });

    // Professional setup
    const profile = await call("PATCH", "/professionals/me", {
      token: pro,
      payload: { timezone: "America/Mexico_City", bio: "Barber", bufferMinutes: 0 },
      status: 200,
      schema: profileResponse,
    });
    const service = await call("POST", "/professionals/me/services", {
      token: pro,
      payload: { name: "Haircut", durationMinutes: 60, priceCents: 25000 },
      status: 201,
      schema: serviceResponse,
    });
    await call("PATCH", `/professionals/me/services/${service.id}`, {
      token: pro,
      payload: { priceCents: 30000 },
      status: 200,
      schema: serviceResponse,
    });
    await call("PUT", "/professionals/me/availability", {
      token: pro,
      payload: { slots: [{ weekday: 1, startMinute: 540, endMinute: 780 }] },
      status: 200,
      schema: z.array(availabilityResponse),
    });
    const timeOff = await call("POST", "/professionals/me/time-off", {
      token: pro,
      payload: { startDate: "2030-02-04", endDate: "2030-02-08", reason: "Vacation" },
      status: 201,
      schema: timeOffResponse,
    });
    await call("GET", "/professionals/me/time-off", { token: pro, status: 200, schema: z.array(timeOffResponse) });
    await call("GET", "/professionals/me", { token: pro, status: 200, schema: profileResponse });

    // Public views
    await call("GET", `/professionals/${profile.id}`, { status: 200, schema: profileResponse });
    const { slots } = await call("GET", `/professionals/${profile.id}/slots?serviceId=${service.id}&date=2030-01-07`, {
      status: 200,
      schema: slotsResponse,
    });

    // Booking
    const book = (startsAt: string) =>
      call("POST", "/appointments", {
        token: client,
        payload: { professionalId: profile.id, serviceId: service.id, startsAt },
        status: 201,
        schema: appointmentResponse,
      });
    const appointment = await book(slots[0].startsAt);
    await call("GET", "/appointments/me", { token: client, status: 200, schema: z.array(appointmentResponse) });
    await call("GET", "/appointments/me?scope=past", { token: pro, status: 200, schema: z.array(appointmentResponse) });

    // Reschedule: request + accept, request + reject, request + withdraw, direct move
    const requests = `/appointments/${appointment.id}/reschedule-requests`;
    const requestChange = (startsAt: string) =>
      call("POST", requests, { token: client, payload: { startsAt }, status: 201, schema: rescheduleRequestResponse });

    const first = await requestChange(slots[4].startsAt);
    const [listed] = await call("GET", "/appointments/me", {
      token: pro,
      status: 200,
      schema: z.array(appointmentResponse),
    });
    expect(listed.pendingReschedule.id).toBe(first.id);
    await call("POST", `${requests}/${first.id}/accept`, { token: pro, status: 200, schema: appointmentResponse });

    const second = await requestChange(slots[8].startsAt);
    await call("POST", `${requests}/${second.id}/reject`, {
      token: pro,
      payload: { reason: "Busy" },
      status: 200,
      schema: rescheduleRequestResponse,
    });
    const third = await requestChange(slots[8].startsAt);
    await call("POST", `${requests}/${third.id}/withdraw`, {
      token: client,
      status: 200,
      schema: rescheduleRequestResponse,
    });
    await call("GET", requests, { token: client, status: 200, schema: z.array(rescheduleRequestResponse) });

    await call("POST", `/appointments/${appointment.id}/reschedule`, {
      token: pro,
      payload: { startsAt: slots[0].startsAt },
      status: 200,
      schema: appointmentResponse,
    });
    await call("POST", `/appointments/${appointment.id}/cancel`, {
      token: client,
      status: 200,
      schema: appointmentResponse,
    });

    // Deletes return no body
    await call("DELETE", `/professionals/me/time-off/${timeOff.id}`, { token: pro, status: 204, schema: null });
    const spare = await call("POST", "/professionals/me/services", {
      token: pro,
      payload: { name: "Beard trim", durationMinutes: 30, priceCents: 15000 },
      status: 201,
      schema: serviceResponse,
    });
    await call("DELETE", `/professionals/me/services/${spare.id}`, { token: pro, status: 204, schema: null });

    // Password reset
    await call("POST", "/auth/password-reset/request", {
      payload: { email: "client@example.com" },
      status: 202,
      schema: messageResponse,
    });
    const code = sent.at(-1)!.text.match(/\d{6}/)![0];
    const { resetToken } = await call("POST", "/auth/password-reset/verify", {
      payload: { email: "client@example.com", code },
      status: 200,
      schema: resetTokenResponse,
    });
    await call("POST", "/auth/password-reset/confirm", {
      payload: { resetToken, newPassword: "N3w$ecret!" },
      status: 204,
      schema: null,
    });

    expect(proUser.role).toBe("PROFESSIONAL");
  });

  it("for errors", async () => {
    const validation = await call("POST", "/auth/register", {
      payload: { email: "nope" },
      status: 400,
      schema: errorResponse,
    });
    expect(validation.issues.length).toBeGreaterThan(0);

    await call("GET", "/auth/me", { status: 401, schema: errorResponse });
    await call("GET", "/professionals/00000000-0000-4000-8000-000000000000", { status: 404, schema: errorResponse });
  });
});
