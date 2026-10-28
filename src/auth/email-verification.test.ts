import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "../../test/db.js";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import type { Notification, Recipient } from "../notifications/notifier.js";

const email = "ana@example.com";
const password = "Sup3r$ecret";

let app: ReturnType<typeof buildApp>;
let sent: (Notification & { to: Recipient })[];

function post(url: string, payload: object) {
  return app.inject({ method: "POST", url: `/auth/verify-email${url}`, payload });
}

function login() {
  return app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
}

function lastCode() {
  return sent.at(-1)!.text.match(/\d{6}/)![0];
}

function wrongCode() {
  return lastCode() === "000000" ? "111111" : "000000";
}

// A fresh app per test also resets the in-memory rate limiter.
beforeEach(async () => {
  await resetDb();
  sent = [];
  app = buildApp({ notifier: { notify: async (to, notification) => void sent.push({ to, ...notification }) } });
  await app.inject({ method: "POST", url: "/auth/register", payload: { email, password, name: "Ana" } });
});

afterEach(() => app.close());
afterAll(() => prisma.$disconnect());

describe("POST /auth/verify-email", () => {
  it("verifies the email with the code sent on registration, unlocking login", async () => {
    expect((await login()).statusCode).toBe(403);

    const res = await post("", { email, code: lastCode() });

    expect(res.statusCode).toBe(204);
    expect((await login()).statusCode).toBe(200);
  });

  it("rejects a wrong code", async () => {
    const res = await post("", { email, code: wrongCode() });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "Invalid or expired code" });
  });

  it("locks the code after 5 failed attempts", async () => {
    for (let i = 0; i < 5; i++) await post("", { email, code: wrongCode() });

    // Even the right code fails once the attempts are used up.
    expect((await post("", { email, code: lastCode() })).statusCode).toBe(400);
  });

  it("rejects an expired code", async () => {
    await prisma.emailVerification.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    expect((await post("", { email, code: lastCode() })).statusCode).toBe(400);
  });

  it("cannot be used twice", async () => {
    const code = lastCode();
    await post("", { email, code });

    expect((await post("", { email, code })).statusCode).toBe(400);
  });

  it("rejects an unknown email", async () => {
    expect((await post("", { email: "nobody@example.com", code: lastCode() })).statusCode).toBe(400);
  });

  it.each([
    ["5 digits", { email, code: "12345" }],
    ["unknown fields", { email, code: "123456", extra: 1 }],
  ])("rejects %s", async (_, body) => {
    expect((await post("", body)).statusCode).toBe(400);
  });
});

describe("POST /auth/verify-email/resend", () => {
  const message = { message: "If the email is registered and not verified, a code has been sent" };

  async function endCooldown() {
    await prisma.emailVerification.updateMany({ data: { createdAt: new Date(Date.now() - 61_000) } });
  }

  it("sends a new code and invalidates the previous one", async () => {
    const first = lastCode();
    await endCooldown();

    const res = await post("/resend", { email });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual(message);
    expect(sent).toHaveLength(2);
    // 1 in a million chance both codes match.
    expect((await post("", { email, code: first })).statusCode).toBe(400);
    expect((await post("", { email, code: lastCode() })).statusCode).toBe(204);
  });

  it("does not resend during the cooldown", async () => {
    const res = await post("/resend", { email });

    expect(res.statusCode).toBe(202);
    expect(sent).toHaveLength(1);
  });

  it("responds the same for unknown and verified emails without sending anything", async () => {
    await post("", { email, code: lastCode() });
    await endCooldown();

    const verified = await post("/resend", { email });
    const unknown = await post("/resend", { email: "nobody@example.com" });

    expect(verified.json()).toEqual(message);
    expect(unknown.json()).toEqual(message);
    expect(sent).toHaveLength(1);
  });

  it("returns 429 after 5 requests from the same IP", async () => {
    for (let i = 0; i < 5; i++) await post("/resend", { email });

    expect((await post("/resend", { email })).statusCode).toBe(429);
  });
});
