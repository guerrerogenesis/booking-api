import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { hashPassword, verifyPassword } from "./password.js";
import { emailSchema, passwordSchema } from "./schemas.js";

const CODE_TTL_MS = 15 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;

// Per-IP throttle, counted separately for each route. Verify allows more because
// each code already has its own MAX_ATTEMPTS limit.
const rateLimit = { max: 5, timeWindow: "15 minutes" };
const verifyRateLimit = { max: 10, timeWindow: "15 minutes" };

const requestBody = z.strictObject({ email: emailSchema });
const verifyBody = z.strictObject({
  email: emailSchema,
  code: z.string().regex(/^\d{6}$/, "Must be a 6-digit code"),
});
const confirmBody = z.strictObject({
  resetToken: z.string().regex(/^[a-f0-9]{64}$/, "Invalid reset token format"),
  newPassword: passwordSchema,
});

// A 6-digit code is trivial to brute-force from a plain hash, so it is keyed with a server secret.
function hashCode(code: string) {
  return createHmac("sha256", process.env.JWT_SECRET!).update(code).digest();
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function passwordResetRoutes(app: FastifyInstance) {
  app.post("/request", { config: { rateLimit } }, async (request, reply) => {
    const { email } = requestBody.parse(request.body);
    const user = await prisma.user.findUnique({ where: { email } });

    const latest = user
      ? await prisma.passwordReset.findFirst({ where: { userId: user.id }, orderBy: { createdAt: "desc" } })
      : null;
    const inCooldown = latest !== null && Date.now() - latest.createdAt.getTime() < RESEND_COOLDOWN_MS;

    if (user && !inCooldown) {
      const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
      await prisma.$transaction([
        prisma.passwordReset.deleteMany({ where: { userId: user.id } }),
        prisma.passwordReset.create({
          data: {
            userId: user.id,
            codeHash: hashCode(code).toString("hex"),
            expiresAt: new Date(Date.now() + CODE_TTL_MS),
          },
        }),
      ]);
      // Not awaited, so response time doesn't reveal whether the email exists.
      app.mailer
        .send({
          to: user.email,
          subject: "Your password reset code",
          text: `Your code is ${code}. It expires in 15 minutes. If you didn't request it, ignore this email.`,
        })
        .catch((err) => request.log.error(err, "Failed to send password reset email"));
    }

    // Same response in every case to avoid revealing which emails are registered.
    return reply.status(202).send({ message: "If the email is registered, a code has been sent" });
  });

  app.post("/verify", { config: { rateLimit: verifyRateLimit } }, async (request, reply) => {
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
    if (count === 0 || !timingSafeEqual(hashCode(code), Buffer.from(reset.codeHash, "hex"))) {
      return invalid();
    }

    const resetToken = randomBytes(32).toString("hex");
    await prisma.passwordReset.update({
      where: { id: reset.id },
      data: { resetTokenHash: hashToken(resetToken) },
    });
    return { resetToken };
  });

  app.post("/confirm", { config: { rateLimit } }, async (request, reply) => {
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
