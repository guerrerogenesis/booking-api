import type { Prisma, Role } from "@prisma/client";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth/plugin.js";
import { prisma } from "../db.js";
import type { Notification, Recipient } from "../notifications/notifier.js";
import { findAvailableSlots } from "../professionals/slots.js";
import { dateIn, formatLocal } from "../professionals/timezone.js";

// Clients can only cancel (or request changes) this far ahead of the appointment.
export const CLIENT_CHANGE_NOTICE_HOURS = 48;

const idParams = z.strictObject({ id: z.uuid() });

const createBody = z.strictObject({
  professionalId: z.uuid(),
  serviceId: z.uuid(),
  // Requires an explicit offset ("Z" or "-06:00") so the instant is never ambiguous.
  startsAt: z.iso.datetime({ offset: true }),
});

const listQuery = z.strictObject({
  scope: z.enum(["upcoming", "past"]).default("upcoming"),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const appointmentSelect = {
  id: true,
  status: true,
  startsAt: true,
  endsAt: true,
  cancelledAt: true,
  cancelledBy: true,
  service: { select: { id: true, name: true, durationMinutes: true, priceCents: true } },
  professional: { select: { id: true, timezone: true, user: { select: { name: true, email: true } } } },
  client: { select: { id: true, name: true, email: true } },
} satisfies Prisma.AppointmentSelect;

type AppointmentRow = Prisma.AppointmentGetPayload<{ select: typeof appointmentSelect }>;

// Emails are loaded for notifications but never returned.
function toResponse(appointment: AppointmentRow) {
  const { professional, client, ...rest } = appointment;
  return {
    ...rest,
    professional: { id: professional.id, name: professional.user.name, timezone: professional.timezone },
    client: { id: client.id, name: client.name },
  };
}

function ownedBy(userId: string, role: Role): Prisma.AppointmentWhereInput {
  return role === "CLIENT" ? { clientId: userId } : { professional: { userId } };
}

function summarize(appointment: AppointmentRow) {
  const { service, professional, startsAt } = appointment;
  return `${service.name} with ${professional.user.name} on ${formatLocal(startsAt, professional.timezone)} (${professional.timezone})`;
}

export async function appointmentRoutes(app: FastifyInstance) {
  // Not awaited: a failing channel shouldn't fail the request.
  function notify(log: FastifyBaseLogger, recipient: Recipient, notification: Notification) {
    app.notifier.notify(recipient, notification).catch((err) => log.error(err, "Failed to send notification"));
  }

  app.post("/", { onRequest: requireRole("CLIENT") }, async (request, reply) => {
    const { professionalId, serviceId, startsAt } = createBody.parse(request.body);
    const requested = new Date(startsAt);

    const result = await prisma.$transaction(async (tx) => {
      // Serializes bookings and time off changes per professional, so two requests can't
      // both see the same slot as free. The exclusion constraint is the last line of defense.
      await tx.$queryRaw`SELECT id FROM "Professional" WHERE id = ${professionalId} FOR UPDATE`;

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

      const slots = await findAvailableSlots(
        tx,
        professional,
        service.durationMinutes,
        dateIn(professional.timezone, requested),
      );
      const slot = slots.find((s) => s.startsAt.getTime() === requested.getTime());
      if (!slot) return { status: 409, body: { error: "This time is not available" } } as const;

      const appointment = await tx.appointment.create({
        data: { professionalId, serviceId, clientId: request.user.sub, startsAt: slot.startsAt, endsAt: slot.endsAt },
        select: appointmentSelect,
      });
      return { status: 201, appointment } as const;
    }).catch((err) => {
      // The lock should prevent this, but if the database's exclusion constraint still
      // rejects an overlap, it's a conflict, not a server error.
      if (err instanceof Error && err.message.includes("Appointment_no_overlap")) {
        return { status: 409, body: { error: "This time is not available" } } as const;
      }
      throw err;
    });

    if (result.status !== 201) return reply.status(result.status).send(result.body);

    const { appointment } = result;
    notify(request.log, appointment.client, {
      subject: "Appointment confirmed",
      text: `Your appointment is confirmed: ${summarize(appointment)}.`,
    });
    notify(request.log, appointment.professional.user, {
      subject: "New appointment",
      text: `${appointment.client.name} booked ${summarize(appointment)}.`,
    });
    return reply.status(201).send(toResponse(appointment));
  });

  app.get("/me", { onRequest: app.authenticate }, async (request) => {
    const { scope, limit, offset } = listQuery.parse(request.query);
    const now = new Date();

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

    const msUntilStart = appointment.startsAt.getTime() - Date.now();
    if (msUntilStart <= 0) {
      return reply.status(409).send({ error: "Appointments that already started can't be cancelled" });
    }
    if (role === "CLIENT" && msUntilStart < CLIENT_CHANGE_NOTICE_HOURS * 3_600_000) {
      return reply.status(403).send({
        error: `Appointments can only be cancelled at least ${CLIENT_CHANGE_NOTICE_HOURS} hours in advance. Contact the professional.`,
      });
    }

    // Conditional update, so two concurrent cancellations can't both succeed.
    const { count } = await prisma.appointment.updateMany({
      where: { id, status: "CONFIRMED" },
      data: { status: "CANCELLED", cancelledAt: new Date(), cancelledBy: role },
    });
    if (count === 0) return reply.status(409).send({ error: "Already cancelled" });

    const cancelled = await prisma.appointment.findUniqueOrThrow({ where: { id }, select: appointmentSelect });
    const [recipient, by] =
      role === "CLIENT" ? [cancelled.professional.user, cancelled.client.name] : [cancelled.client, cancelled.professional.user.name];
    notify(request.log, recipient, {
      subject: "Appointment cancelled",
      text: `${summarize(cancelled)} was cancelled by ${by}.`,
    });
    return toResponse(cancelled);
  });
}
