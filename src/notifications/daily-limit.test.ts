import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "../../test/db.js";
import { prisma } from "../db.js";
import { withDailyLimit } from "./daily-limit.js";
import type { Notification } from "./notifier.js";

const to = { name: "Ana", email: "ana@example.com" };
const notification = { subject: "Hi", text: "Hello" };

let delivered: Notification[];
const inner = { notify: async (_: unknown, n: Notification) => void delivered.push(n) };

beforeEach(async () => {
  await resetDb();
  delivered = [];
});

afterAll(() => prisma.$disconnect());

describe("withDailyLimit", () => {
  it("delivers up to the limit, then refuses without calling the channel", async () => {
    const notifier = withDailyLimit(inner, prisma, 2);

    await notifier.notify(to, notification);
    await notifier.notify(to, notification);
    await expect(notifier.notify(to, notification)).rejects.toThrow("Daily notification limit of 2 reached");

    expect(delivered).toHaveLength(2);
  });

  it("counts across instances, so a restart doesn't reset it", async () => {
    await withDailyLimit(inner, prisma, 1).notify(to, notification);

    await expect(withDailyLimit(inner, prisma, 1).notify(to, notification)).rejects.toThrow();
    expect(delivered).toHaveLength(1);
  });

  it("starts over on a new UTC day", async () => {
    await prisma.$executeRaw`
      INSERT INTO "NotificationUsage" (day, count) VALUES ((now() AT TIME ZONE 'UTC')::date - 1, 1)`;

    await withDailyLimit(inner, prisma, 1).notify(to, notification);

    expect(delivered).toHaveLength(1);
  });

  it("counts concurrent sends exactly", async () => {
    const notifier = withDailyLimit(inner, prisma, 5);

    const results = await Promise.allSettled(Array.from({ length: 10 }, () => notifier.notify(to, notification)));

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    expect(delivered).toHaveLength(5);
  });
});
