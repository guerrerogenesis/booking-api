import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "../../test/db.js";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";

const app = buildApp();

const credentials = { email: "ana@example.com", password: "Sup3r$ecret", name: "Ana" };

function register(body: object) {
  return app.inject({ method: "POST", url: "/auth/register", payload: body });
}

function login(body: object) {
  return app.inject({ method: "POST", url: "/auth/login", payload: body });
}

beforeEach(resetDb);
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
    await register(credentials);
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
});

describe("GET /auth/me", () => {
  it("returns the current user for a valid token", async () => {
    await register(credentials);
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
