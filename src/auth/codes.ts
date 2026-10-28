import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { z } from "zod";

// 6-digit emailed codes, shared by password reset and email verification.
export const CODE_TTL_MS = 15 * 60 * 1000;
export const RESEND_COOLDOWN_MS = 60 * 1000;
export const MAX_ATTEMPTS = 5;

export const codeSchema = z.string().regex(/^\d{6}$/, "Must be a 6-digit code");

export function generateCode() {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

// A 6-digit code is trivial to brute-force from a plain hash, so it is keyed with a server secret.
export function hashCode(code: string) {
  return createHmac("sha256", process.env.JWT_SECRET!).update(code).digest("hex");
}

export function codeMatches(code: string, codeHash: string) {
  return timingSafeEqual(Buffer.from(hashCode(code), "hex"), Buffer.from(codeHash, "hex"));
}

export function inCooldown(latest: { createdAt: Date } | null) {
  return latest !== null && Date.now() - latest.createdAt.getTime() < RESEND_COOLDOWN_MS;
}
