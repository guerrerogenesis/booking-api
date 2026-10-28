import type { User } from "@prisma/client";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { doc, messageResponse, withOperationIds } from "../docs.js";
import { CODE_TTL_MS, MAX_ATTEMPTS, codeMatches, codeSchema, generateCode, hashCode, inCooldown } from "./codes.js";
import { emailSchema } from "./schemas.js";

// Same throttles as password reset.
const resendRateLimit = { max: 5, timeWindow: "15 minutes" };
const verifyRateLimit = { max: 10, timeWindow: "15 minutes" };

const verifyBody = z.strictObject({ email: emailSchema, code: codeSchema });
const resendBody = z.strictObject({ email: emailSchema });

const docs = withOperationIds({
  verifyEmail: doc({
    tag: "Auth",
    summary: "Verify the email with the emailed code",
    description:
      "Accounts can't log in until verified. Each code expires in 15 minutes and allows 5 attempts. " +
      "Rate limited to 10 per 15 minutes per IP.",
    body: verifyBody,
    response: { 204: null },
    errors: [429],
  }),
  resendVerificationCode: doc({
    tag: "Auth",
    summary: "Send a new verification code",
    description:
      "Always answers `202` with the same message. Only unverified accounts get a code, at most one per 60 seconds. " +
      "Rate limited to 5 per 15 minutes per IP.",
    body: resendBody,
    response: { 202: messageResponse },
    errors: [429],
  }),
});

// Replaces any previous code for the user.
export async function sendVerificationCode(
  app: FastifyInstance,
  log: FastifyBaseLogger,
  user: Pick<User, "id" | "name" | "email">,
) {
  const code = generateCode();
  await prisma.$transaction([
    prisma.emailVerification.deleteMany({ where: { userId: user.id } }),
    prisma.emailVerification.create({
      data: { userId: user.id, codeHash: hashCode(code), expiresAt: new Date(Date.now() + CODE_TTL_MS) },
    }),
  ]);
  // Not awaited, so response time doesn't reveal whether the email exists.
  app.notifier
    .notify(user, {
      subject: "Verify your email",
      text: `Your verification code is ${code}. It expires in 15 minutes. If you didn't create an account, ignore this message.`,
    })
    .catch((err) => log.error(err, "Failed to send verification code"));
}

export async function emailVerificationRoutes(app: FastifyInstance) {
  app.post("", { schema: docs.verifyEmail, config: { rateLimit: verifyRateLimit } }, async (request, reply) => {
    const { email, code } = verifyBody.parse(request.body);
    const invalid = () => reply.status(400).send({ error: "Invalid or expired code" });

    const verification = await prisma.emailVerification.findFirst({
      where: { user: { email, emailVerifiedAt: null }, expiresAt: { gt: new Date() } },
    });
    if (!verification) return invalid();

    // Count the attempt atomically before checking, so parallel guesses can't exceed the limit.
    const { count } = await prisma.emailVerification.updateMany({
      where: { id: verification.id, attempts: { lt: MAX_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });
    if (count === 0 || !codeMatches(code, verification.codeHash)) return invalid();

    await prisma.$transaction([
      prisma.user.update({ where: { id: verification.userId }, data: { emailVerifiedAt: new Date() } }),
      prisma.emailVerification.deleteMany({ where: { userId: verification.userId } }),
    ]);
    return reply.status(204).send();
  });

  app.post("/resend", { schema: docs.resendVerificationCode, config: { rateLimit: resendRateLimit } }, async (request, reply) => {
    const { email } = resendBody.parse(request.body);
    const user = await prisma.user.findUnique({ where: { email } });

    if (user && !user.emailVerifiedAt) {
      const latest = await prisma.emailVerification.findFirst({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
      });
      if (!inCooldown(latest)) await sendVerificationCode(app, request.log, user);
    }

    // Same response in every case to avoid revealing which emails are registered or verified.
    return reply.status(202).send({ message: "If the email is registered and not verified, a code has been sent" });
  });
}
