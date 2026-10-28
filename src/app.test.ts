import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { prisma } from "./db.js";

describe("GET /health", () => {
  it("returns ok", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});

describe("client IP behind a proxy", () => {
  // Render appends the real client IP to whatever X-Forwarded-For the client sent.
  const login = (app: ReturnType<typeof buildApp>, forwardedFor: string) =>
    app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { "x-forwarded-for": forwardedFor },
      payload: { email: "nobody@example.com", password: "Wr0ng$pass" },
    });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await prisma.$disconnect();
  });

  it("rate-limits by the address the proxy saw, so a spoofed X-Forwarded-For doesn't help", async () => {
    vi.stubEnv("TRUST_PROXY_HOPS", "1");
    const app = buildApp();

    for (let i = 0; i < 10; i++) await login(app, `10.0.0.${i}, 203.0.113.7`);

    expect((await login(app, "10.0.0.99, 203.0.113.7")).statusCode).toBe(429);
    expect((await login(app, "203.0.113.8")).statusCode).not.toBe(429);
    await app.close();
  });

  it("ignores X-Forwarded-For when no proxy is trusted", async () => {
    const app = buildApp();

    for (let i = 0; i < 10; i++) await login(app, `203.0.113.${i}`);

    expect((await login(app, "203.0.113.99")).statusCode).toBe(429);
    await app.close();
  });
});
