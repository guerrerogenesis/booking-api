import type { Prisma, Role } from "@prisma/client";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { z } from "zod";
import type { Notification, Recipient } from "../notifications/notifier.js";
import { formatLocal } from "../professionals/timezone.js";

// Clients can only cancel or request changes this far ahead of the appointment.
export const CLIENT_CHANGE_NOTICE_HOURS = 48;
const CLIENT_CHANGE_NOTICE_MS = CLIENT_CHANGE_NOTICE_HOURS * 3_600_000;

export const idParams = z.strictObject({ id: z.uuid() });
// Requires an explicit offset ("Z" or "-06:00") so the instant is never ambiguous.
export const startsAtSchema = z.iso.datetime({ offset: true });

export const rescheduleRequestSelect = {
  id: true,
  appointmentId: true,
  startsAt: true,
  endsAt: true,
  status: true,
  rejectionReason: true,
  createdAt: true,
  respondedAt: true,
} satisfies Prisma.RescheduleRequestSelect;

export const appointmentSelect = {
  id: true,
  status: true,
  startsAt: true,
  endsAt: true,
  cancelledAt: true,
  cancelledBy: true,
  service: { select: { id: true, name: true, durationMinutes: true, priceCents: true } },
  professional: {
    select: {
      id: true,
      timezone: true,
      maxAppointmentsPerDay: true,
      bufferMinutes: true,
      user: { select: { name: true, email: true } },
    },
  },
  client: { select: { id: true, name: true, email: true } },
  rescheduleRequests: { where: { status: "PENDING" }, select: rescheduleRequestSelect, take: 1 },
} satisfies Prisma.AppointmentSelect;

export type AppointmentRow = Prisma.AppointmentGetPayload<{ select: typeof appointmentSelect }>;

// Emails and booking settings are loaded for internal use but never returned.
export function toResponse(appointment: AppointmentRow) {
  const { professional, client, rescheduleRequests, ...rest } = appointment;
  return {
    ...rest,
    professional: { id: professional.id, name: professional.user.name, timezone: professional.timezone },
    client: { id: client.id, name: client.name },
    pendingReschedule: rescheduleRequests[0] ?? null,
  };
}

export function ownedBy(userId: string, role: Role): Prisma.AppointmentWhereInput {
  return role === "CLIENT" ? { clientId: userId } : { professional: { userId } };
}

export function hasClientNotice(startsAt: Date) {
  return startsAt.getTime() - Date.now() >= CLIENT_CHANGE_NOTICE_MS;
}

export function durationOf(appointment: { startsAt: Date; endsAt: Date }) {
  return (appointment.endsAt.getTime() - appointment.startsAt.getTime()) / 60_000;
}

export function localTime(startsAt: Date, appointment: AppointmentRow) {
  return `${formatLocal(startsAt, appointment.professional.timezone)} (${appointment.professional.timezone})`;
}

export function summarize(appointment: AppointmentRow) {
  const { service, professional, startsAt } = appointment;
  return `${service.name} with ${professional.user.name} on ${localTime(startsAt, appointment)}`;
}

// Serializes every change to a professional's schedule (bookings, moves, time off),
// so two requests can't both see the same slot as free.
export async function lockProfessional(tx: Prisma.TransactionClient, professionalId: string) {
  await tx.$queryRaw`SELECT id FROM "Professional" WHERE id = ${professionalId} FOR UPDATE`;
}

// The exclusion constraint is the last line of defense behind the lock.
export function isOverlapError(err: unknown) {
  return err instanceof Error && err.message.includes("Appointment_no_overlap");
}

// Pending requests close automatically once fewer than 48h remain before the appointment.
// Evaluated lazily before reading or acting on requests, so no background job is needed.
export async function expireStaleRequests(db: Prisma.TransactionClient) {
  await db.rescheduleRequest.updateMany({
    where: { status: "PENDING", appointment: { startsAt: { lt: new Date(Date.now() + CLIENT_CHANGE_NOTICE_MS) } } },
    data: { status: "EXPIRED", respondedAt: new Date() },
  });
}

// Not awaited: a failing channel shouldn't fail the request.
export function notify(app: FastifyInstance, log: FastifyBaseLogger, recipient: Recipient, notification: Notification) {
  app.notifier.notify(recipient, notification).catch((err) => log.error(err, "Failed to send notification"));
}
