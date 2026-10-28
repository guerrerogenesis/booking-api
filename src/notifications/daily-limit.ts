import type { PrismaClient } from "@prisma/client";
import type { Notifier } from "./notifier.js";

// Decorates any channel with a global cap per UTC day, so abuse (many IPs registering
// other people's emails, for example) can't burn the provider quota or the domain's reputation.
// The counter lives in the database, so restarts and multiple instances share it.
export function withDailyLimit(inner: Notifier, db: PrismaClient, limit: number): Notifier {
  return {
    async notify(recipient, notification) {
      const [{ count }] = await db.$queryRaw<{ count: number }[]>`
        INSERT INTO "NotificationUsage" (day, count) VALUES ((now() AT TIME ZONE 'UTC')::date, 1)
        ON CONFLICT (day) DO UPDATE SET count = "NotificationUsage".count + 1
        RETURNING count`;
      if (count > limit) throw new Error(`Daily notification limit of ${limit} reached`);
      await inner.notify(recipient, notification);
    },
  };
}
