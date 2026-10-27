import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyError } from "fastify";
import { ZodError } from "zod";
import { passwordResetRoutes } from "./auth/password-reset.js";
import { registerAuth } from "./auth/plugin.js";
import { authRoutes } from "./auth/routes.js";
import { createSmtpMailer, type Mailer } from "./mailer.js";

declare module "fastify" {
  interface FastifyInstance {
    mailer: Mailer;
  }
}

export function buildApp(options: { mailer?: Mailer } = {}) {
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
  app.decorate("mailer", options.mailer ?? createSmtpMailer());
  // Opt-in per route via `config.rateLimit`. In-memory store: use Redis when running multiple instances.
  app.register(rateLimit, { global: false });

  app.get("/health", async () => ({ status: "ok" }));
  app.register(authRoutes, { prefix: "/auth" });
  app.register(passwordResetRoutes, { prefix: "/auth/password-reset" });

  return app;
}
