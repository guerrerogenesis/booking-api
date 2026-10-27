import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyError } from "fastify";
import { ZodError } from "zod";
import { rescheduleRoutes } from "./appointments/reschedule.js";
import { appointmentRoutes } from "./appointments/routes.js";
import { passwordResetRoutes } from "./auth/password-reset.js";
import { registerAuth } from "./auth/plugin.js";
import { authRoutes } from "./auth/routes.js";
import { doc, healthResponse, registerDocs } from "./docs.js";
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

  registerDocs(app);
  registerAuth(app);
  app.decorate("notifier", options.notifier ?? createNotifier());
  // Opt-in per route via `config.rateLimit`. In-memory store: use Redis when running multiple instances.
  app.register(rateLimit, { global: false });

  // Inside a plugin so it's registered after the docs plugin and shows up in the spec.
  app.register(async (health) => {
    const schema = { ...doc({ tag: "Health", summary: "Health check", response: { 200: healthResponse } }), operationId: "healthCheck" };
    health.get("/health", { schema }, async () => ({ status: "ok" }));
  });
  app.register(authRoutes, { prefix: "/auth" });
  app.register(passwordResetRoutes, { prefix: "/auth/password-reset" });
  app.register(professionalRoutes, { prefix: "/professionals" });
  app.register(appointmentRoutes, { prefix: "/appointments" });
  app.register(rescheduleRoutes, { prefix: "/appointments" });

  return app;
}
