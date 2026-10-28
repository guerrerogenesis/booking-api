import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "../../test/db.js";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import type { Notification, Recipient } from "../notifications/notifier.js";

const email = "ana@example.com";
const oldPassword = "Old$ecret1";
const newPassword = "N3w$ecret!";

let app: ReturnType<typeof buildApp>;
let sent: (Notification & { to: Recipient })[];

function post(url: string, payload: object) {
  return app.inject({ method: "POST", url: `/auth/password-reset${url}`, payload });
}

function lastCode() {
  return sent.at(-1)!.text.match(/\d{6}/)![0];
}

async function getResetToken() {
  await post("/request", { email });
  const res = await post("/verify", { email, code: lastCode() });
  return res.json().resetToken as string;
}

// A fresh app per test also resets the in-memory rate limiter.
beforeEach(async () => {
  await resetDb();
  sent = [];
  app = buildApp({ notifier: { notify: async (to, notification) => void sent.push({ to, ...notification }) } });
  await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { email, password: oldPassword, name: "Ana" },
  });
  await prisma.user.update({ where: { email }, data: { emailVerifiedAt: new Date() } });
  sent = []; // drop the verification email
});

afterEach(() => app.close());
afterAll(() => prisma.$disconnect());

describe("full flow", () => {
  it("resets the password with the emailed code", async () => {
    const resetToken = await getResetToken();

    const res = await post("/confirm", { resetToken, newPassword });
    expect(res.statusCode).toBe(204);

    const login = (password: string) =>
      app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
    expect((await login(newPassword)).statusCode).toBe(200);
    expect((await login(oldPassword)).statusCode).toBe(401);
  });
});

describe("POST /request", () => {
  it("emails a 6-digit code", async () => {
    const res = await post("/request", { email });

    expect(res.statusCode).toBe(202);
    expect(sent).toHaveLength(1);
    expect(sent[0].to.email).toBe(email);
    expect(lastCode()).toMatch(/^\d{6}$/);
  });

  it("responds the same for unknown emails without sending anything", async () => {
    const known = await post("/request", { email });
    const unknown = await post("/request", { email: "nobody@example.com" });

    expect(unknown.statusCode).toBe(known.statusCode);
    expect(unknown.json()).toEqual(known.json());
    expect(sent).toHaveLength(1);
  });

  it("sends nothing to an unverified email, with the same response", async () => {
    await prisma.user.update({ where: { email }, data: { emailVerifiedAt: null } });

    const res = await post("/request", { email });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ message: "If the email is registered, a code has been sent" });
    expect(sent).toHaveLength(0);
  });

  it("does not resend a code during the cooldown", async () => {
    await post("/request", { email });
    const res = await post("/request", { email });

    expect(res.statusCode).toBe(202);
    expect(sent).toHaveLength(1);
  });

  it.each([
    ["an invalid email", { email: "not-an-email" }],
    ["a missing email", {}],
    ["unknown fields", { email, extra: 1 }],
  ])("rejects %s", async (_, body) => {
    expect((await post("/request", body)).statusCode).toBe(400);
  });
});

describe("POST /verify", () => {
  beforeEach(async () => {
    await post("/request", { email });
  });

  it("returns a reset token for the right code", async () => {
    const res = await post("/verify", { email, code: lastCode() });

    expect(res.statusCode).toBe(200);
    expect(res.json().resetToken).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects a wrong code", async () => {
    const wrong = lastCode() === "000000" ? "111111" : "000000";
    const res = await post("/verify", { email, code: wrong });

    expect(res.statusCode).toBe(400);
  });

  it("locks the code after 5 failed attempts", async () => {
    const wrong = lastCode() === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) await post("/verify", { email, code: wrong });

    // Even the right code fails once the attempts are used up.
    const res = await post("/verify", { email, code: lastCode() });

    expect(res.statusCode).toBe(400);
  });

  it("rejects an expired code", async () => {
    await prisma.passwordReset.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    expect((await post("/verify", { email, code: lastCode() })).statusCode).toBe(400);
  });

  it("cannot be used twice", async () => {
    const code = lastCode();
    await post("/verify", { email, code });

    expect((await post("/verify", { email, code })).statusCode).toBe(400);
  });

  it.each([
    ["5 digits", "12345"],
    ["7 digits", "1234567"],
    ["letters", "12a456"],
  ])("rejects a code with %s", async (_, code) => {
    expect((await post("/verify", { email, code })).statusCode).toBe(400);
  });
});

describe("POST /confirm", () => {
  it("rejects a password that doesn't meet the requirements", async () => {
    const resetToken = await getResetToken();
    const res = await post("/confirm", { resetToken, newPassword: "weakpassword" });

    expect(res.statusCode).toBe(400);
    expect(res.json().issues.length).toBeGreaterThan(0);
  });

  it("rejects reusing the current password", async () => {
    const resetToken = await getResetToken();
    const res = await post("/confirm", { resetToken, newPassword: oldPassword });

    expect(res.statusCode).toBe(400);
  });

  it("makes the reset token single-use", async () => {
    const resetToken = await getResetToken();
    await post("/confirm", { resetToken, newPassword });

    expect((await post("/confirm", { resetToken, newPassword: "An0ther$ecret" })).statusCode).toBe(400);
  });

  it("rejects an unknown or malformed token", async () => {
    expect((await post("/confirm", { resetToken: "a".repeat(64), newPassword })).statusCode).toBe(400);
    expect((await post("/confirm", { resetToken: "not-hex", newPassword })).statusCode).toBe(400);
  });
});

describe("rate limiting", () => {
  it("returns 429 after 5 requests from the same IP", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await post("/request", { email: `user${i}@example.com` })).statusCode).toBe(202);
    }
    const res = await post("/request", { email });

    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
  });
});
