import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth/plugin.js";
import { prisma } from "../db.js";
import {
  availabilityResponse,
  doc,
  profileResponse,
  serviceResponse,
  slotsResponse,
  timeOffResponse,
  withOperationIds,
} from "../docs.js";
import { bookingWindow, findAvailableSlots } from "./slots.js";
import { canonicalTimeZone, todayIn } from "./timezone.js";

declare module "fastify" {
  interface FastifyRequest {
    professionalId: string;
  }
}

const idParams = z.strictObject({ id: z.uuid() });
const serviceParams = z.strictObject({ serviceId: z.uuid() });
const timeOffParams = z.strictObject({ timeOffId: z.uuid() });
const slotsQuery = z.strictObject({ serviceId: z.uuid(), date: z.iso.date() });

const timezoneSchema = z
  .string()
  .trim()
  .max(64)
  .transform((value, ctx) => {
    const timezone = canonicalTimeZone(value);
    if (!timezone) {
      ctx.addIssue({ code: "custom", message: "Must be an IANA time zone, e.g. America/Mexico_City" });
      return z.NEVER;
    }
    return timezone;
  });

const profileBody = z
  .strictObject({
    bio: z.string().trim().max(500).nullable(),
    timezone: timezoneSchema,
    maxAppointmentsPerDay: z.int().min(1).max(100).nullable(),
    bufferMinutes: z.int().min(0).max(120).multipleOf(5),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, "At least one field is required");

const MAX_TIME_OFF_DAYS = 365;
const timeOffBody = z
  .strictObject({
    startDate: z.iso.date(),
    endDate: z.iso.date(),
    reason: z.string().trim().min(1).max(200).optional(),
  })
  // YYYY-MM-DD strings compare correctly as text.
  .refine((body) => body.startDate <= body.endDate, { message: "Must be on or after startDate", path: ["endDate"] })
  .refine((body) => (Date.parse(body.endDate) - Date.parse(body.startDate)) / 86_400_000 < MAX_TIME_OFF_DAYS, {
    message: `Can't span more than ${MAX_TIME_OFF_DAYS} days`,
    path: ["endDate"],
  });

const serviceFields = {
  name: z.string().trim().min(1).max(100),
  durationMinutes: z.int().min(5).max(480).multipleOf(5),
  priceCents: z.int().min(0).max(10_000_000),
};
const createServiceBody = z.strictObject(serviceFields);
const updateServiceBody = z
  .strictObject(serviceFields)
  .partial()
  .refine((body) => Object.keys(body).length > 0, "At least one field is required");

// Minutes from midnight, in 5-minute steps so slots line up with service durations.
const minuteOfDay = z
  .int()
  .min(0)
  .max(1440)
  .multipleOf(5)
  .meta({ description: "Minutes from midnight in the professional's timezone (540 = 09:00)" });
const availabilityBody = z
  .strictObject({
    slots: z
      .array(
        z
          .strictObject({ weekday: z.int().min(0).max(6), startMinute: minuteOfDay, endMinute: minuteOfDay })
          .refine((slot) => slot.startMinute < slot.endMinute, {
            message: "Must be after startMinute",
            path: ["endMinute"],
          }),
      )
      .max(50),
  })
  .superRefine(({ slots }, ctx) => {
    const sorted = slots
      .map((slot, index) => ({ ...slot, index }))
      .sort((a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute);
    for (let i = 1; i < sorted.length; i++) {
      const [prev, cur] = [sorted[i - 1], sorted[i]];
      if (cur.weekday === prev.weekday && cur.startMinute < prev.endMinute) {
        ctx.addIssue({ code: "custom", message: "Overlaps another slot on the same day", path: ["slots", cur.index] });
      }
    }
  });

const serviceSelect = { id: true, name: true, durationMinutes: true, priceCents: true } as const;
const slotSelect = { weekday: true, startMinute: true, endMinute: true } as const;
const slotOrder = [{ weekday: "asc" }, { startMinute: "asc" }] as const;

async function findProfile(where: Prisma.ProfessionalWhereUniqueInput) {
  const professional = await prisma.professional.findUnique({
    where,
    select: {
      id: true,
      bio: true,
      timezone: true,
      maxAppointmentsPerDay: true,
      bufferMinutes: true,
      user: { select: { name: true } },
      services: { select: serviceSelect, orderBy: { name: "asc" } },
      availability: { select: slotSelect, orderBy: [...slotOrder] },
    },
  });
  if (!professional) return null;
  const { user, ...rest } = professional;
  return { ...rest, name: user.name };
}

const timeOffSelect = { id: true, startDate: true, endDate: true, reason: true } as const;

function toDateString(date: Date) {
  return date.toISOString().slice(0, 10);
}

function formatTimeOff(timeOff: { id: string; startDate: Date; endDate: Date; reason: string | null }) {
  return { ...timeOff, startDate: toDateString(timeOff.startDate), endDate: toDateString(timeOff.endDate) };
}

function isPrismaError(err: unknown, code: string) {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === code;
}

const ownProfile = { tag: "My profile", auth: true, errors: [403] } as const;

const docs = withOperationIds({
  getProfessional: doc({
    tag: "Professionals",
    summary: "Public profile",
    params: idParams,
    response: { 200: profileResponse },
    errors: [404],
  }),
  getAvailableSlots: doc({
    tag: "Professionals",
    summary: "Available start times",
    description:
      "Free start times for a service on a date in the professional's timezone, every 15 minutes. " +
      "Accounts for weekly availability, time off, the daily limit, the buffer between appointments and existing bookings. " +
      "Bookable from 2 hours ahead up to 60 days ahead.",
    params: idParams,
    querystring: slotsQuery,
    response: { 200: slotsResponse },
    errors: [404],
  }),
  getMyProfile: doc({ ...ownProfile, summary: "Own profile", response: { 200: profileResponse } }),
  updateMyProfile: doc({
    ...ownProfile,
    summary: "Update bio, timezone and booking settings",
    body: profileBody,
    response: { 200: profileResponse },
  }),
  createService: doc({ ...ownProfile, summary: "Create a service", body: createServiceBody, response: { 201: serviceResponse } }),
  updateService: doc({
    ...ownProfile,
    summary: "Update a service",
    params: serviceParams,
    body: updateServiceBody,
    response: { 200: serviceResponse },
    errors: [403, 404],
  }),
  deleteService: doc({
    ...ownProfile,
    summary: "Delete a service",
    description: "Services with appointments can't be deleted (`409`).",
    params: serviceParams,
    response: { 204: null },
    errors: [403, 404, 409],
  }),
  replaceAvailability: doc({
    ...ownProfile,
    summary: "Replace the weekly schedule",
    description: "Replaces all blocks atomically. Blocks on the same day can't overlap; an empty list clears the schedule.",
    body: availabilityBody,
    response: { 200: z.array(availabilityResponse) },
  }),
  listTimeOff: doc({ ...ownProfile, summary: "Upcoming time off", response: { 200: z.array(timeOffResponse) } }),
  createTimeOff: doc({
    ...ownProfile,
    summary: "Add days out of service",
    description:
      "Whole days, inclusive, in the professional's timezone. Rejected with `409` if it overlaps other time off " +
      "or if there are confirmed appointments on those days (they're listed in the response).",
    body: timeOffBody,
    response: { 201: timeOffResponse },
    errors: [403, 409],
  }),
  deleteTimeOff: doc({
    ...ownProfile,
    summary: "Remove time off",
    params: timeOffParams,
    response: { 204: null },
    errors: [403, 404],
  }),
});

export async function professionalRoutes(app: FastifyInstance) {
  app.get("/:id", { schema: docs.getProfessional }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const profile = await findProfile({ id });
    if (!profile) return reply.status(404).send({ error: "Professional not found" });
    return profile;
  });

  app.get("/:id/slots", { schema: docs.getAvailableSlots }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const { serviceId, date } = slotsQuery.parse(request.query);

    const professional = await prisma.professional.findUnique({
      where: { id },
      select: {
        timezone: true,
        maxAppointmentsPerDay: true,
        bufferMinutes: true,
        services: { where: { id: serviceId }, select: { durationMinutes: true } },
      },
    });
    if (!professional) return reply.status(404).send({ error: "Professional not found" });
    const [service] = professional.services;
    if (!service) return reply.status(404).send({ error: "Service not found" });

    const { firstDay, lastDay } = bookingWindow(professional.timezone);
    if (date < firstDay || date > lastDay) {
      return reply.status(400).send({ error: `date must be between ${firstDay} and ${lastDay}` });
    }

    const slots = await findAvailableSlots(prisma, { id, ...professional }, service.durationMinutes, date);
    return { date, timezone: professional.timezone, durationMinutes: service.durationMinutes, slots };
  });

  // Everything under /me is scoped to the authenticated professional, so ownership
  // is enforced by the queries themselves.
  app.register(
    async (me) => {
      me.decorateRequest("professionalId", "");
      me.addHook("onRequest", requireRole("PROFESSIONAL"));
      me.addHook("preHandler", async (request, reply) => {
        const professional = await prisma.professional.findUnique({
          where: { userId: request.user.sub },
          select: { id: true },
        });
        if (!professional) return reply.status(403).send({ error: "Forbidden" });
        request.professionalId = professional.id;
      });

      me.get("", { schema: docs.getMyProfile }, async (request) => findProfile({ id: request.professionalId }));

      me.patch("", { schema: docs.updateMyProfile }, async (request) => {
        const data = profileBody.parse(request.body);
        await prisma.professional.update({ where: { id: request.professionalId }, data });
        return findProfile({ id: request.professionalId });
      });

      me.post("/services", { schema: docs.createService }, async (request, reply) => {
        const data = createServiceBody.parse(request.body);
        const service = await prisma.service.create({
          data: { ...data, professionalId: request.professionalId },
          select: serviceSelect,
        });
        return reply.status(201).send(service);
      });

      me.patch("/services/:serviceId", { schema: docs.updateService }, async (request, reply) => {
        const { serviceId } = serviceParams.parse(request.params);
        const data = updateServiceBody.parse(request.body);
        try {
          return await prisma.service.update({
            where: { id: serviceId, professionalId: request.professionalId },
            data,
            select: serviceSelect,
          });
        } catch (err) {
          if (isPrismaError(err, "P2025")) return reply.status(404).send({ error: "Service not found" });
          throw err;
        }
      });

      me.delete("/services/:serviceId", { schema: docs.deleteService }, async (request, reply) => {
        const { serviceId } = serviceParams.parse(request.params);
        try {
          await prisma.service.delete({ where: { id: serviceId, professionalId: request.professionalId } });
          return reply.status(204).send();
        } catch (err) {
          if (isPrismaError(err, "P2025")) return reply.status(404).send({ error: "Service not found" });
          if (isPrismaError(err, "P2003")) {
            return reply.status(409).send({ error: "Service has appointments and can't be deleted" });
          }
          throw err;
        }
      });

      // Replaces the whole weekly schedule atomically.
      me.put("/availability", { schema: docs.replaceAvailability }, async (request) => {
        const { slots } = availabilityBody.parse(request.body);
        const professionalId = request.professionalId;
        await prisma.$transaction([
          prisma.availability.deleteMany({ where: { professionalId } }),
          prisma.availability.createMany({ data: slots.map((slot) => ({ ...slot, professionalId })) }),
        ]);
        return prisma.availability.findMany({ where: { professionalId }, select: slotSelect, orderBy: [...slotOrder] });
      });

      // Upcoming time off (including any period in progress today).
      me.get("/time-off", { schema: docs.listTimeOff }, async (request) => {
        const { timezone } = await prisma.professional.findUniqueOrThrow({
          where: { id: request.professionalId },
          select: { timezone: true },
        });
        const timeOff = await prisma.timeOff.findMany({
          where: { professionalId: request.professionalId, endDate: { gte: new Date(todayIn(timezone)) } },
          select: timeOffSelect,
          orderBy: { startDate: "asc" },
        });
        return timeOff.map(formatTimeOff);
      });

      me.post("/time-off", { schema: docs.createTimeOff }, async (request, reply) => {
        const { startDate, endDate, reason } = timeOffBody.parse(request.body);
        const professionalId = request.professionalId;

        const result = await prisma.$transaction(async (tx) => {
          // Lock the professional row so a booking can't slip in between the checks and the insert.
          const [{ timezone }] = await tx.$queryRaw<{ timezone: string }[]>`
            SELECT timezone FROM "Professional" WHERE id = ${professionalId} FOR UPDATE`;

          if (startDate < todayIn(timezone)) {
            return { status: 400, body: { error: "startDate can't be in the past" } };
          }

          const overlapping = await tx.timeOff.findFirst({
            where: { professionalId, startDate: { lte: new Date(endDate) }, endDate: { gte: new Date(startDate) } },
            select: timeOffSelect,
          });
          if (overlapping) {
            return { status: 409, body: { error: "Overlaps existing time off", timeOff: formatTimeOff(overlapping) } };
          }

          // Appointments that touch any of those days in the professional's local time.
          const appointments = await tx.$queryRaw<{ id: string; startsAt: Date; endsAt: Date }[]>`
            SELECT id, "startsAt", "endsAt" FROM "Appointment"
            WHERE "professionalId" = ${professionalId}
              AND status = 'CONFIRMED'
              AND ("startsAt" AT TIME ZONE ${timezone}) < ${endDate}::date + 1
              AND ("endsAt" AT TIME ZONE ${timezone}) > ${startDate}::date
            ORDER BY "startsAt"`;
          if (appointments.length > 0) {
            return {
              status: 409,
              body: { error: "There are appointments on those days. Reschedule or cancel them first.", appointments },
            };
          }

          const timeOff = await tx.timeOff.create({
            data: { professionalId, startDate: new Date(startDate), endDate: new Date(endDate), reason },
            select: timeOffSelect,
          });
          return { status: 201, body: formatTimeOff(timeOff) };
        });

        return reply.status(result.status).send(result.body);
      });

      me.delete("/time-off/:timeOffId", { schema: docs.deleteTimeOff }, async (request, reply) => {
        const { timeOffId } = timeOffParams.parse(request.params);
        try {
          await prisma.timeOff.delete({ where: { id: timeOffId, professionalId: request.professionalId } });
          return reply.status(204).send();
        } catch (err) {
          if (isPrismaError(err, "P2025")) return reply.status(404).send({ error: "Time off not found" });
          throw err;
        }
      });
    },
    { prefix: "/me" },
  );
}
