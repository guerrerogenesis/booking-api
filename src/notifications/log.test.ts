import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { createNotifier } from "./notifier.js";

describe("log channel", () => {
  it("logs the recipient and subject, never the body", async () => {
    const info = vi.fn();
    const notifier = createNotifier({ info } as unknown as FastifyBaseLogger, "log");

    await notifier.notify({ name: "Ana", email: "ana@example.com" }, { subject: "Verify", text: "Code 123456" });

    expect(info).toHaveBeenCalledWith({ to: "ana@example.com", subject: "Verify" }, expect.any(String));
    expect(JSON.stringify(info.mock.calls)).not.toContain("123456");
  });
});
