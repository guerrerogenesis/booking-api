import type { FastifyBaseLogger } from "fastify";
import { prisma } from "../db.js";
import { withDailyLimit } from "./daily-limit.js";
import { createEmailNotifier } from "./email.js";
import { createLogNotifier } from "./log.js";

export interface Recipient {
  name: string;
  email: string;
}

export interface Notification {
  subject: string;
  text: string;
}

// Each channel (email, SMS, WhatsApp...) is an adapter implementing this interface,
// so the rest of the app never depends on a specific provider.
export interface Notifier {
  notify(recipient: Recipient, notification: Notification): Promise<void>;
}

export function createNotifier(log: FastifyBaseLogger, channel = process.env.NOTIFIER_CHANNEL ?? "email"): Notifier {
  const limit = Number(process.env.NOTIFICATION_DAILY_LIMIT ?? 100);
  switch (channel) {
    case "email":
      return withDailyLimit(createEmailNotifier(), prisma, limit);
    case "log":
      return createLogNotifier(log);
    default:
      throw new Error(`Unknown notifier channel: ${channel}`);
  }
}
