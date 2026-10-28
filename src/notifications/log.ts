import type { FastifyBaseLogger } from "fastify";
import type { Notifier } from "./notifier.js";

// Sends nothing; records that a notification would have gone out. For the public demo, which
// has no email provider. The body is left out because it may contain verification or reset codes.
export function createLogNotifier(log: FastifyBaseLogger): Notifier {
  return {
    async notify(recipient, { subject }) {
      log.info({ to: recipient.email, subject }, "Notification not sent (log channel)");
    },
  };
}
