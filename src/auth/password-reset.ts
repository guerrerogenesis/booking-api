import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { doc, messageResponse, resetTokenResponse, withOperationIds } from "../docs.js";
import { CODE_TTL_MS, MAX_ATTEMPTS, codeMatches, codeSchema, generateCode, hashCode, inCooldown } from "./codes.js";
import { hashPassword, verifyPassword } from "./password.js";
import { emailSchema, passwordSchema } from "./schemas.js";

// Per-IP throttle, counted separately for each route. Verify allows more because
// each code already has its own MAX_ATTEMPTS limit.
const rateLimit = { max: 5, timeWindow: "15 minutes" };
const verifyRateLimit = { max: 10, timeWindow: "15 minutes" };

const requestBody = z.strictObject({ email: emailSchema });
const verifyBody = z.strictObject({
  email: emailSchema,
  code: codeSchema,
});
const confirmBody = z.strictObject({
  resetToken: z.string().regex(/^[a-f0-9]{64}$/, "Invalid reset token format"),
  newPassword: passwordSchema,
});

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

const docs = withOperationIds({
  requestPasswordReset: doc({
    tag: "Password reset",
    summary: "1. Email a reset code",
    description:
      "Always answers `202` with the same message, whether or not the email is registered. " +
      "Codes are only sent to verified emails. " +
      "The 6-digit code expires in 15 minutes; a new one can't be sent within 60 seconds. Rate limited to 5 per 15 minutes per IP.",
    body: requestBody,
    response: { 202: messageResponse },
    errors: [429],
  }),
  verifyResetCode: doc({
    tag: "Password reset",
    summary: "2. Exchange the code for a reset token",
    description: "Each code allows 5 attempts. Rate limited to 10 per 15 minutes per IP.",
    body: verifyBody,
    response: { 200: resetTokenResponse },
    errors: [429],
  }),
  confirmPasswordReset: doc({
    tag: "Password reset",
    summary: "3. Set a new password",
    description: "The reset token is single-use. The new password must differ from the current one.",
    body: confirmBody,
    response: { 204: null },
    errors: [429],
  }),
});

export async function passwordResetRoutes(app: FastifyInstance) {
  app.post("/request", { schema: docs.requestPasswordReset, config: { rateLimit } }, async (request, reply) => {
    const { email } = requestBody.parse(request.body);
    const user = await prisma.user.findUnique({ where: { email } });

    // Unverified emails get nothing: the address may belong to someone who never signed up.
    const eligible = user?.emailVerifiedAt ? user : null;
    const latest = eligible
      ? await prisma.passwordReset.findFirst({ where: { userId: eligible.id }, orderBy: { createdAt: "desc" } })
      : null;

    if (eligible && !inCooldown(latest)) {
      const code = generateCode();
      await prisma.$transaction([
        prisma.passwordReset.deleteMany({ where: { userId: eligible.id } }),
        prisma.passwordReset.create({
          data: {
            userId: eligible.id,
            codeHash: hashCode(code),
            expiresAt: new Date(Date.now() + CODE_TTL_MS),
          },
        }),
      ]);
      // Not awaited, so response time doesn't reveal whether the email exists.
      app.notifier
        .notify(eligible, {
          subject: "Your password reset code",
          text: `Your code is ${code}. It expires in 15 minutes. If you didn't request it, ignore this message.`,
        })
        .catch((err) => request.log.error(err, "Failed to send password reset code"));
    }

    // Same response in every case to avoid revealing which emails are registered.
    return reply.status(202).send({ message: "If the email is registered, a code has been sent" });
  });

  app.post("/verify", { schema: docs.verifyResetCode, config: { rateLimit: verifyRateLimit } }, async (request, reply) => {
    const { email, code } = verifyBody.parse(request.body);
    const invalid = () => reply.status(400).send({ error: "Invalid or expired code" });

    const reset = await prisma.passwordReset.findFirst({
      where: { user: { email }, resetTokenHash: null, expiresAt: { gt: new Date() } },
    });
    if (!reset) return invalid();

    // Count the attempt atomically before checking, so parallel guesses can't exceed the limit.
    const { count } = await prisma.passwordReset.updateMany({
      where: { id: reset.id, attempts: { lt: MAX_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });
    if (count === 0 || !codeMatches(code, reset.codeHash)) {
      return invalid();
    }

    const resetToken = randomBytes(32).toString("hex");
    await prisma.passwordReset.update({
      where: { id: reset.id },
      data: { resetTokenHash: hashToken(resetToken) },
    });
    return { resetToken };
  });

  app.post("/confirm", { schema: docs.confirmPasswordReset, config: { rateLimit } }, async (request, reply) => {
    const { resetToken, newPassword } = confirmBody.parse(request.body);

    const reset = await prisma.passwordReset.findUnique({
      where: { resetTokenHash: hashToken(resetToken) },
      include: { user: true },
    });
    if (!reset || reset.expiresAt <= new Date()) {
      return reply.status(400).send({ error: "Invalid or expired reset token" });
    }
    if (await verifyPassword(newPassword, reset.user.passwordHash)) {
      return reply.status(400).send({ error: "New password must be different from the current one" });
    }

    const passwordHash = await hashPassword(newPassword);
    const used = await prisma.$transaction(async (tx) => {
      // Deleting first makes the token single-use even under concurrent requests.
      const { count } = await tx.passwordReset.deleteMany({ where: { id: reset.id } });
      if (count === 0) return false;
      await tx.user.update({ where: { id: reset.userId }, data: { passwordHash } });
      return true;
    });
    if (!used) return reply.status(400).send({ error: "Invalid or expired reset token" });

    return reply.status(204).send();
  });
}
