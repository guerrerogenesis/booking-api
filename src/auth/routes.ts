import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { doc, tokenResponse, userResponse, withOperationIds } from "../docs.js";
import { sendVerificationCode } from "./email-verification.js";
import { hashPassword, verifyPassword } from "./password.js";
import { emailSchema, passwordSchema } from "./schemas.js";

const registerBody = z.strictObject({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().trim().min(1).max(100),
  role: z.enum(["CLIENT", "PROFESSIONAL"]).default("CLIENT"),
});

// No password policy here: login only checks what was stored.
const loginBody = z.strictObject({
  email: emailSchema,
  password: z.string().min(1).max(128),
});

const publicUser = { id: true, email: true, name: true, role: true } as const;

const docs = withOperationIds({
  register: doc({
    tag: "Auth",
    summary: "Create an account",
    description:
      "Emails a 6-digit verification code; the account can't log in until it's verified. " +
      "Registering as `PROFESSIONAL` also creates an empty professional profile. Rate limited to 5 per hour per IP.",
    body: registerBody,
    response: { 201: userResponse },
    errors: [409, 429],
  }),
  login: doc({
    tag: "Auth",
    summary: "Log in",
    description: "`403` if the email isn't verified yet. Rate limited to 10 attempts per minute per IP.",
    body: loginBody,
    response: { 200: tokenResponse },
    errors: [401, 403, 429],
  }),
  getCurrentUser: doc({ tag: "Auth", summary: "Current user", auth: true, response: { 200: userResponse }, errors: [404] }),
});

export async function authRoutes(app: FastifyInstance) {
  // Each account triggers an email, so registrations are throttled harder than logins.
  const registerRateLimit = { max: 5, timeWindow: "1 hour" };
  app.post("/register", { schema: docs.register, config: { rateLimit: registerRateLimit } }, async (request, reply) => {
    const { password, ...data } = registerBody.parse(request.body);

    try {
      const user = await prisma.user.create({
        data: {
          ...data,
          passwordHash: await hashPassword(password),
          professional: data.role === "PROFESSIONAL" ? { create: {} } : undefined,
        },
        select: publicUser,
      });
      await sendVerificationCode(app, request.log, user);
      return reply.status(201).send(user);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return reply.status(409).send({ error: "Email already registered" });
      }
      throw err;
    }
  });

  const loginRateLimit = { max: 10, timeWindow: "1 minute" };
  app.post("/login", { schema: docs.login, config: { rateLimit: loginRateLimit } }, async (request, reply) => {
    const { email, password } = loginBody.parse(request.body);

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      return reply.status(401).send({ error: "Invalid email or password" });
    }
    // Only after the password matched, so this doesn't reveal which emails are registered.
    if (!user.emailVerifiedAt) return reply.status(403).send({ error: "Email not verified" });

    const token = app.jwt.sign({ sub: user.id, role: user.role });
    return { token };
  });

  app.get("/me", { schema: docs.getCurrentUser, onRequest: app.authenticate }, async (request, reply) => {
    const user = await prisma.user.findUnique({ where: { id: request.user.sub }, select: publicUser });
    if (!user) return reply.status(404).send({ error: "User not found" });
    return user;
  });
}
