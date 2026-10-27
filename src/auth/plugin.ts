import fastifyJwt from "@fastify/jwt";
import type { Role } from "@prisma/client";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string; role: Role };
    user: { sub: string; role: Role };
  }
}

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest) => Promise<void>;
  }
}

export function registerAuth(app: FastifyInstance) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not set");

  app.register(fastifyJwt, { secret, sign: { expiresIn: "1h" } });

  app.decorate("authenticate", async (request: FastifyRequest) => {
    await request.jwtVerify();
  });
}

export function requireRole(role: Role) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    await request.jwtVerify();
    if (request.user.role !== role) return reply.status(403).send({ error: "Forbidden" });
  };
}
