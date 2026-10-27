import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth/plugin.js";
import { prisma } from "../db.js";
import { findSlotAt } from "../professionals/slots.js";
import {
  appointmentSelect,
  CLIENT_CHANGE_NOTICE_HOURS,
  durationOf,
  expireStaleRequests,
  hasClientNotice,
  idParams,
  isOverlapError,
  localTime,
  lockProfessional,
  notify,
  ownedBy,
  rescheduleRequestSelect,
  startsAtSchema,
  summarize,
  toResponse,
} from "./shared.js";

const requestParams = z.strictObject({ id: z.uuid(), requestId: z.uuid() });
const startsAtBody = z.strictObject({ startsAt: startsAtSchema });
const rejectBody = z.strictObject({ reason: z.string().trim().min(1).max(200).optional() });

const notAvailable = { status: 409, body: { error: "The requested time is not available" } } as const;

export async function rescheduleRoutes(app: FastifyInstance) {
  // Client proposes a new time; the appointment stays as is until the professional answers.
  app.post("/:id/reschedule-requests", { onRequest: requireRole("CLIENT") }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const requested = new Date(startsAtBody.parse(request.body).startsAt);

    await expireStaleRequests(prisma);
    const appointment = await prisma.appointment.findFirst({
      where: { id, clientId: request.user.sub },
      select: appointmentSelect,
    });
    if (!appointment) return reply.status(404).send({ error: "Appointment not found" });
    if (appointment.status === "CANCELLED") return reply.status(409).send({ error: "Appointment is cancelled" });
    if (!hasClientNotice(appointment.startsAt)) {
      return reply.status(403).send({
        error: `Changes can only be requested at least ${CLIENT_CHANGE_NOTICE_HOURS} hours in advance. Contact the professional.`,
      });
    }
    if (requested.getTime() === appointment.startsAt.getTime()) {
      return reply.status(400).send({ error: "The requested time is the current time" });
    }
    if (appointment.rescheduleRequests.length > 0) {
      return reply.status(409).send({ error: "There is already a pending request for this appointment" });
    }

    const slot = await findSlotAt(prisma, appointment.professional, durationOf(appointment), requested, id);
    if (!slot) return reply.status(notAvailable.status).send(notAvailable.body);

    try {
      const created = await prisma.rescheduleRequest.create({
        data: { appointmentId: id, startsAt: slot.startsAt, endsAt: slot.endsAt },
        select: rescheduleRequestSelect,
      });
      notify(app, request.log, appointment.professional.user, {
        subject: "Reschedule requested",
        text: `${appointment.client.name} asked to move ${summarize(appointment)} to ${localTime(slot.startsAt, appointment)}.`,
      });
      return reply.status(201).send(created);
    } catch (err) {
      // The partial unique index catches a concurrent second request.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return reply.status(409).send({ error: "There is already a pending request for this appointment" });
      }
      throw err;
    }
  });

  app.get("/:id/reschedule-requests", { onRequest: app.authenticate }, async (request, reply) => {
    const { id } = idParams.parse(request.params);

    await expireStaleRequests(prisma);
    const appointment = await prisma.appointment.findFirst({
      where: { id, ...ownedBy(request.user.sub, request.user.role) },
      select: { rescheduleRequests: { select: rescheduleRequestSelect, orderBy: { createdAt: "desc" } } },
    });
    if (!appointment) return reply.status(404).send({ error: "Appointment not found" });
    return appointment.rescheduleRequests;
  });

  app.post(
    "/:id/reschedule-requests/:requestId/accept",
    { onRequest: requireRole("PROFESSIONAL") },
    async (request, reply) => {
      const { id, requestId } = requestParams.parse(request.params);

      await expireStaleRequests(prisma);
      const result = await prisma
        .$transaction(async (tx) => {
          const pending = await findRequest(tx, id, requestId, request.user.sub);
          if (!pending) return { status: 404, body: { error: "Request not found" } } as const;
          if (pending.status !== "PENDING") {
            return { status: 409, body: { error: `Request is already ${pending.status.toLowerCase()}` } } as const;
          }

          const { appointment } = pending;
          await lockProfessional(tx, appointment.professional.id);
          // Re-check: the requested time wasn't held, someone may have booked it meanwhile.
          const slot = await findSlotAt(tx, appointment.professional, durationOf(appointment), pending.startsAt, id);
          if (!slot) return notAvailable;

          const { count } = await tx.rescheduleRequest.updateMany({
            where: { id: requestId, status: "PENDING" },
            data: { status: "ACCEPTED", respondedAt: new Date() },
          });
          if (count === 0) return { status: 409, body: { error: "Request is no longer pending" } } as const;

          const moved = await tx.appointment.update({
            where: { id },
            data: { startsAt: slot.startsAt, endsAt: slot.endsAt },
            select: appointmentSelect,
          });
          return { status: 200, previous: appointment.startsAt, appointment: moved } as const;
        })
        .catch((err) => {
          if (isOverlapError(err)) return notAvailable;
          throw err;
        });

      if (result.status !== 200) return reply.status(result.status).send(result.body);

      const { appointment, previous } = result;
      notify(app, request.log, appointment.client, {
        subject: "Reschedule accepted",
        text: `Your appointment was moved from ${localTime(previous, appointment)}: ${summarize(appointment)}.`,
      });
      return toResponse(appointment);
    },
  );

  app.post(
    "/:id/reschedule-requests/:requestId/reject",
    { onRequest: requireRole("PROFESSIONAL") },
    async (request, reply) => {
      const { id, requestId } = requestParams.parse(request.params);
      const { reason } = rejectBody.parse(request.body ?? {});

      await expireStaleRequests(prisma);
      const pending = await findRequest(prisma, id, requestId, request.user.sub);
      if (!pending) return reply.status(404).send({ error: "Request not found" });

      const { count } = await prisma.rescheduleRequest.updateMany({
        where: { id: requestId, status: "PENDING" },
        data: { status: "REJECTED", rejectionReason: reason, respondedAt: new Date() },
      });
      if (count === 0) {
        return reply.status(409).send({ error: `Request is already ${pending.status.toLowerCase()}` });
      }

      notify(app, request.log, pending.appointment.client, {
        subject: "Reschedule rejected",
        text:
          `Your request to move ${summarize(pending.appointment)} was rejected. Your appointment stays as is.` +
          (reason ? ` Reason: ${reason}` : ""),
      });
      return prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: requestId }, select: rescheduleRequestSelect });
    },
  );

  app.post(
    "/:id/reschedule-requests/:requestId/withdraw",
    { onRequest: requireRole("CLIENT") },
    async (request, reply) => {
      const { id, requestId } = requestParams.parse(request.params);

      const { count } = await prisma.rescheduleRequest.updateMany({
        where: { id: requestId, appointmentId: id, status: "PENDING", appointment: { clientId: request.user.sub } },
        data: { status: "WITHDRAWN", respondedAt: new Date() },
      });
      if (count === 0) return reply.status(404).send({ error: "No pending request found" });
      return prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: requestId }, select: rescheduleRequestSelect });
    },
  );

  // The professional moves an appointment directly, at any time before it starts.
  app.post("/:id/reschedule", { onRequest: requireRole("PROFESSIONAL") }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const requested = new Date(startsAtBody.parse(request.body).startsAt);

    const result = await prisma
      .$transaction(async (tx) => {
        const appointment = await tx.appointment.findFirst({
          where: { id, professional: { userId: request.user.sub } },
          select: appointmentSelect,
        });
        if (!appointment) return { status: 404, body: { error: "Appointment not found" } } as const;
        if (appointment.status === "CANCELLED") {
          return { status: 409, body: { error: "Appointment is cancelled" } } as const;
        }
        if (appointment.startsAt.getTime() <= Date.now()) {
          return { status: 409, body: { error: "Appointments that already started can't be moved" } } as const;
        }
        if (requested.getTime() === appointment.startsAt.getTime()) {
          return { status: 400, body: { error: "The requested time is the current time" } } as const;
        }

        await lockProfessional(tx, appointment.professional.id);
        const slot = await findSlotAt(tx, appointment.professional, durationOf(appointment), requested, id);
        if (!slot) return notAvailable;

        // A direct move makes any pending client request moot.
        await tx.rescheduleRequest.updateMany({
          where: { appointmentId: id, status: "PENDING" },
          data: { status: "CANCELLED", respondedAt: new Date() },
        });
        const moved = await tx.appointment.update({
          where: { id },
          data: { startsAt: slot.startsAt, endsAt: slot.endsAt },
          select: appointmentSelect,
        });
        return { status: 200, previous: appointment.startsAt, appointment: moved } as const;
      })
      .catch((err) => {
        if (isOverlapError(err)) return notAvailable;
        throw err;
      });

    if (result.status !== 200) return reply.status(result.status).send(result.body);

    const { appointment, previous } = result;
    notify(app, request.log, appointment.client, {
      subject: "Appointment moved",
      text: `${appointment.professional.user.name} moved your appointment from ${localTime(previous, appointment)}: ${summarize(appointment)}.`,
    });
    return toResponse(appointment);
  });
}

// A request on one of the professional's own appointments, with what's needed to act on it.
function findRequest(db: Prisma.TransactionClient, appointmentId: string, requestId: string, professionalUserId: string) {
  return db.rescheduleRequest.findFirst({
    where: { id: requestId, appointmentId, appointment: { professional: { userId: professionalUserId } } },
    select: { status: true, startsAt: true, appointment: { select: appointmentSelect } },
  });
}
