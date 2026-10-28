import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "../../test/db.js";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import type { Notification, Recipient } from "../notifications/notifier.js";

const sent: (Notification & { to: Recipient })[] = [];
const app = buildApp({ notifier: { notify: async (to, notification) => void sent.push({ to, ...notification }) } });

const credentials = { email: "ana@example.com", password: "Sup3r$ecret", name: "Ana" };

// Each call comes from a different IP, so only the rate limit test hits the register limit.
let ip = 0;
function register(body: object, remoteAddress = `10.0.${Math.floor(++ip / 250)}.${ip % 250}`) {
  return app.inject({ method: "POST", url: "/auth/register", payload: body, remoteAddress });
}

async function registerVerified(body: typeof credentials) {
  await register(body);
  const code = sent.findLast((n) => n.to.email === body.email)!.text.match(/\d{6}/)![0];
  await app.inject({ method: "POST", url: "/auth/verify-email", payload: { email: body.email, code } });
}

function login(body: object) {
  return app.inject({ method: "POST", url: "/auth/login", payload: body });
}

beforeEach(async () => {
  await resetDb();
  sent.length = 0;
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("POST /auth/register", () => {
  it("creates a client by default without exposing the password hash", async () => {
    const res = await register(credentials);

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      id: expect.any(String),
      email: credentials.email,
      name: credentials.name,
      role: "CLIENT",
    });
  });

  it("creates a professional profile for professionals", async () => {
    const res = await register({ ...credentials, role: "PROFESSIONAL" });

    expect(res.statusCode).toBe(201);
    const professional = await prisma.professional.findUnique({ where: { userId: res.json().id } });
    expect(professional).not.toBeNull();
  });

  it("emails a verification code to the new address", async () => {
    await register(credentials);

    expect(sent).toHaveLength(1);
    expect(sent[0].to.email).toBe(credentials.email);
    expect(sent[0].text).toMatch(/\b\d{6}\b/);
  });

  it("allows 5 registrations per hour from the same IP", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await register({ ...credentials, email: `user${i}@example.com` }, "203.0.113.1");
      expect(res.statusCode).toBe(201);
    }

    const res = await register({ ...credentials, email: "user5@example.com" }, "203.0.113.1");
    expect(res.statusCode).toBe(429);
  });

  it("rejects a duplicate email", async () => {
    await register(credentials);
    const res = await register(credentials);

    expect(res.statusCode).toBe(409);
  });

  it("rejects invalid input", async () => {
    const res = await register({ ...credentials, email: "not-an-email", password: "short" });

    expect(res.statusCode).toBe(400);
    const paths = res.json().issues.map((issue: { path: string[] }) => issue.path[0]);
    expect(new Set(paths)).toEqual(new Set(["email", "password"]));
  });

  it.each([
    ["too short", "Ab1$"],
    ["no uppercase", "sup3r$ecret"],
    ["no lowercase", "SUP3R$ECRET"],
    ["no number", "Super$ecret"],
    ["no symbol", "Sup3rSecret"],
    ["a space", "Sup3r $ecret"],
  ])("rejects a password with %s", async (_, password) => {
    const res = await register({ ...credentials, password });

    expect(res.statusCode).toBe(400);
  });

  it("rejects unknown fields", async () => {
    const res = await register({ ...credentials, isAdmin: true });

    expect(res.statusCode).toBe(400);
  });

  it("normalizes the email", async () => {
    const res = await register({ ...credentials, email: "  Ana@Example.COM " });

    expect(res.json().email).toBe("ana@example.com");
  });
});

describe("POST /auth/login", () => {
  beforeEach(async () => {
    await registerVerified(credentials);
  });

  it("returns a token for valid credentials", async () => {
    const res = await login({ email: credentials.email, password: credentials.password });

    expect(res.statusCode).toBe(200);
    expect(res.json().token).toEqual(expect.any(String));
  });

  it.each([
    ["wrong password", { email: credentials.email, password: "wrongpassword" }],
    ["unknown email", { email: "nobody@example.com", password: credentials.password }],
  ])("rejects %s with the same error", async (_, body) => {
    const res = await login(body);

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Invalid email or password" });
  });

  it("rejects an unverified account, but only after the password matched", async () => {
    const pending = { ...credentials, email: "pending@example.com" };
    await register(pending);

    const res = await login({ email: pending.email, password: pending.password });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "Email not verified" });

    const wrong = await login({ email: pending.email, password: "Wr0ng$pass" });
    expect(wrong.statusCode).toBe(401);
  });
});

describe("GET /auth/me", () => {
  it("returns the current user for a valid token", async () => {
    await registerVerified(credentials);
    const { token } = (await login({ email: credentials.email, password: credentials.password })).json();

    const res = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().email).toBe(credentials.email);
  });

  it.each([
    ["no token", undefined],
    ["an invalid token", "Bearer not-a-jwt"],
  ])("rejects requests with %s", async (_, authorization) => {
    const res = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: authorization ? { authorization } : {},
    });

    expect(res.statusCode).toBe(401);
  });
});
