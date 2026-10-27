import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyError } from "fastify";
import { ZodError } from "zod";
import { appointmentRoutes } from "./appointments/routes.js";
import { passwordResetRoutes } from "./auth/password-reset.js";
import { registerAuth } from "./auth/plugin.js";
import { authRoutes } from "./auth/routes.js";
import { createNotifier, type Notifier } from "./notifications/notifier.js";
import { professionalRoutes } from "./professionals/routes.js";

declare module "fastify" {
  interface FastifyInstance {
    notifier: Notifier;
  }
}

export function buildApp(options: { notifier?: Notifier } = {}) {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });

  app.setErrorHandler<FastifyError | ZodError>((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({ error: "Validation failed", issues: error.issues });
    }
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) request.log.error(error);
    return reply
      .status(statusCode)
      .send({ error: statusCode >= 500 ? "Internal Server Error" : error.message });
  });

  registerAuth(app);
  app.decorate("notifier", options.notifier ?? createNotifier());
  // Opt-in per route via `config.rateLimit`. In-memory store: use Redis when running multiple instances.
  app.register(rateLimit, { global: false });

  app.get("/health", async () => ({ status: "ok" }));
  app.register(authRoutes, { prefix: "/auth" });
  app.register(passwordResetRoutes, { prefix: "/auth/password-reset" });
  app.register(professionalRoutes, { prefix: "/professionals" });
  app.register(appointmentRoutes, { prefix: "/appointments" });

  return app;
}
