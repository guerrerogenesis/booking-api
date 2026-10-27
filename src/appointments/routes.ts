import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth/plugin.js";
import { prisma } from "../db.js";
import { findSlotAt } from "../professionals/slots.js";
import {
  appointmentSelect,
  CLIENT_CHANGE_NOTICE_HOURS,
  expireStaleRequests,
  hasClientNotice,
  idParams,
  isOverlapError,
  lockProfessional,
  notify,
  ownedBy,
  startsAtSchema,
  summarize,
  toResponse,
} from "./shared.js";

const createBody = z.strictObject({
  professionalId: z.uuid(),
  serviceId: z.uuid(),
  startsAt: startsAtSchema,
});

const listQuery = z.strictObject({
  scope: z.enum(["upcoming", "past"]).default("upcoming"),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function appointmentRoutes(app: FastifyInstance) {
  app.post("/", { onRequest: requireRole("CLIENT") }, async (request, reply) => {
    const { professionalId, serviceId, startsAt } = createBody.parse(request.body);
    const requested = new Date(startsAt);

    const result = await prisma
      .$transaction(async (tx) => {
        await lockProfessional(tx, professionalId);

        const professional = await tx.professional.findUnique({
          where: { id: professionalId },
          select: {
            id: true,
            timezone: true,
            maxAppointmentsPerDay: true,
            bufferMinutes: true,
            services: { where: { id: serviceId }, select: { durationMinutes: true } },
          },
        });
        if (!professional) return { status: 404, body: { error: "Professional not found" } } as const;
        const [service] = professional.services;
        if (!service) return { status: 404, body: { error: "Service not found" } } as const;

        const slot = await findSlotAt(tx, professional, service.durationMinutes, requested);
        if (!slot) return { status: 409, body: { error: "This time is not available" } } as const;

        const appointment = await tx.appointment.create({
          data: { professionalId, serviceId, clientId: request.user.sub, startsAt: slot.startsAt, endsAt: slot.endsAt },
          select: appointmentSelect,
        });
        return { status: 201, appointment } as const;
      })
      .catch((err) => {
        if (isOverlapError(err)) return { status: 409, body: { error: "This time is not available" } } as const;
        throw err;
      });

    if (result.status !== 201) return reply.status(result.status).send(result.body);

    const { appointment } = result;
    notify(app, request.log, appointment.client, {
      subject: "Appointment confirmed",
      text: `Your appointment is confirmed: ${summarize(appointment)}.`,
    });
    notify(app, request.log, appointment.professional.user, {
      subject: "New appointment",
      text: `${appointment.client.name} booked ${summarize(appointment)}.`,
    });
    return reply.status(201).send(toResponse(appointment));
  });

  app.get("/me", { onRequest: app.authenticate }, async (request) => {
    const { scope, limit, offset } = listQuery.parse(request.query);
    const now = new Date();

    await expireStaleRequests(prisma);
    const appointments = await prisma.appointment.findMany({
      where: {
        ...ownedBy(request.user.sub, request.user.role),
        endsAt: scope === "upcoming" ? { gt: now } : { lte: now },
      },
      orderBy: { startsAt: scope === "upcoming" ? "asc" : "desc" },
      take: limit,
      skip: offset,
      select: appointmentSelect,
    });
    return appointments.map(toResponse);
  });

  app.post("/:id/cancel", { onRequest: app.authenticate }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const { sub, role } = request.user;

    const appointment = await prisma.appointment.findFirst({
      where: { id, ...ownedBy(sub, role) },
      select: appointmentSelect,
    });
    if (!appointment) return reply.status(404).send({ error: "Appointment not found" });
    if (appointment.status === "CANCELLED") return reply.status(409).send({ error: "Already cancelled" });

    if (appointment.startsAt.getTime() <= Date.now()) {
      return reply.status(409).send({ error: "Appointments that already started can't be cancelled" });
    }
    if (role === "CLIENT" && !hasClientNotice(appointment.startsAt)) {
      return reply.status(403).send({
        error: `Appointments can only be cancelled at least ${CLIENT_CHANGE_NOTICE_HOURS} hours in advance. Contact the professional.`,
      });
    }

    const cancelled = await prisma.$transaction(async (tx) => {
      // Conditional update, so two concurrent cancellations can't both succeed.
      const { count } = await tx.appointment.updateMany({
        where: { id, status: "CONFIRMED" },
        data: { status: "CANCELLED", cancelledAt: new Date(), cancelledBy: role },
      });
      if (count === 0) return null;
      await tx.rescheduleRequest.updateMany({
        where: { appointmentId: id, status: "PENDING" },
        data: { status: "CANCELLED", respondedAt: new Date() },
      });
      return tx.appointment.findUniqueOrThrow({ where: { id }, select: appointmentSelect });
    });
    if (!cancelled) return reply.status(409).send({ error: "Already cancelled" });

    const [recipient, by] =
      role === "CLIENT"
        ? [cancelled.professional.user, cancelled.client.name]
        : [cancelled.client, cancelled.professional.user.name];
    notify(app, request.log, recipient, {
      subject: "Appointment cancelled",
      text: `${summarize(cancelled)} was cancelled by ${by}.`,
    });
    return toResponse(cancelled);
  });
}
