import { randomUUID } from "node:crypto";
import type { Role } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";

// Creates a user directly in the database and signs a token for it, skipping the
// login endpoint (and its rate limit).
export async function createUser(app: FastifyInstance, role: Role = "CLIENT") {
  await app.ready();
  const user = await prisma.user.create({
    data: {
      email: `${randomUUID()}@example.com`,
      name: `Test ${role.toLowerCase()}`,
      passwordHash: "unused",
      emailVerifiedAt: new Date(),
      role,
      professional: role === "PROFESSIONAL" ? { create: {} } : undefined,
    },
    include: { professional: true },
  });
  const token = app.jwt.sign({ sub: user.id, role });
  return { user, professionalId: user.professional?.id, headers: { authorization: `Bearer ${token}` } };
}
