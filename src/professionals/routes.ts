import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth/plugin.js";
import { prisma } from "../db.js";
import { canonicalTimeZone, todayIn } from "./timezone.js";

declare module "fastify" {
  interface FastifyRequest {
    professionalId: string;
  }
}

const idParams = z.strictObject({ id: z.uuid() });
const serviceParams = z.strictObject({ serviceId: z.uuid() });
const timeOffParams = z.strictObject({ timeOffId: z.uuid() });

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
const minuteOfDay = z.int().min(0).max(1440).multipleOf(5);
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

export async function professionalRoutes(app: FastifyInstance) {
  app.get("/:id", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const profile = await findProfile({ id });
    if (!profile) return reply.status(404).send({ error: "Professional not found" });
    return profile;
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

      me.get("/", async (request) => findProfile({ id: request.professionalId }));

      me.patch("/", async (request) => {
        const data = profileBody.parse(request.body);
        await prisma.professional.update({ where: { id: request.professionalId }, data });
        return findProfile({ id: request.professionalId });
      });

      me.post("/services", async (request, reply) => {
        const data = createServiceBody.parse(request.body);
        const service = await prisma.service.create({
          data: { ...data, professionalId: request.professionalId },
          select: serviceSelect,
        });
        return reply.status(201).send(service);
      });

      me.patch("/services/:serviceId", async (request, reply) => {
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

      me.delete("/services/:serviceId", async (request, reply) => {
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
      me.put("/availability", async (request) => {
        const { slots } = availabilityBody.parse(request.body);
        const professionalId = request.professionalId;
        await prisma.$transaction([
          prisma.availability.deleteMany({ where: { professionalId } }),
          prisma.availability.createMany({ data: slots.map((slot) => ({ ...slot, professionalId })) }),
        ]);
        return prisma.availability.findMany({ where: { professionalId }, select: slotSelect, orderBy: [...slotOrder] });
      });

      // Upcoming time off (including any period in progress today).
      me.get("/time-off", async (request) => {
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

      me.post("/time-off", async (request, reply) => {
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

      me.delete("/time-off/:timeOffId", async (request, reply) => {
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
