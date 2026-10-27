import type { Prisma, PrismaClient } from "@prisma/client";
import { addDays, dateIn, todayIn, weekdayOf, zonedTimeToUtc } from "./timezone.js";

export const SLOT_STEP_MINUTES = 15;
export const MIN_NOTICE_MINUTES = 120;
export const BOOKING_WINDOW_DAYS = 60;

interface TimeRange {
  startsAt: Date;
  endsAt: Date;
}

export interface Slot extends TimeRange {
  localTime: string; // HH:MM in the professional's timezone
}

interface SlotInput {
  date: string; // YYYY-MM-DD, local to timeZone
  timeZone: string;
  blocks: { startMinute: number; endMinute: number }[]; // availability for that weekday
  durationMinutes: number;
  bufferMinutes: number;
  appointments: TimeRange[]; // confirmed appointments around that day
  notBefore: Date;
}

// Pure function: every start time on `date` where the service fits inside the working
// hours and keeps `bufferMinutes` away from every existing appointment.
export function computeSlots(input: SlotInput): Slot[] {
  const durationMs = input.durationMinutes * 60_000;
  const bufferMs = input.bufferMinutes * 60_000;
  const slots: Slot[] = [];

  for (const block of mergeAdjacent(input.blocks)) {
    for (let minute = block.startMinute; minute + input.durationMinutes <= block.endMinute; minute += SLOT_STEP_MINUTES) {
      const startsAt = zonedTimeToUtc(input.date, minute, input.timeZone);
      const endsAt = new Date(startsAt.getTime() + durationMs);
      if (startsAt < input.notBefore) continue;

      const clashes = input.appointments.some(
        (appointment) =>
          startsAt.getTime() < appointment.endsAt.getTime() + bufferMs &&
          endsAt.getTime() + bufferMs > appointment.startsAt.getTime(),
      );
      if (!clashes) slots.push({ startsAt, endsAt, localTime: formatMinutes(minute) });
    }
  }
  return slots;
}

// 9-12 and 12-15 become 9-15, so a service can span both blocks.
function mergeAdjacent(blocks: SlotInput["blocks"]) {
  const sorted = [...blocks].sort((a, b) => a.startMinute - b.startMinute);
  const merged: SlotInput["blocks"] = [];
  for (const block of sorted) {
    const last = merged.at(-1);
    if (last && block.startMinute <= last.endMinute) last.endMinute = Math.max(last.endMinute, block.endMinute);
    else merged.push({ ...block });
  }
  return merged;
}

export function bookingWindow(timeZone: string) {
  const firstDay = todayIn(timeZone);
  return { firstDay, lastDay: addDays(firstDay, BOOKING_WINDOW_DAYS) };
}

interface BookingSettings {
  id: string;
  timezone: string;
  maxAppointmentsPerDay: number | null;
  bufferMinutes: number;
}

type Db = PrismaClient | Prisma.TransactionClient;

// Loads everything that affects availability on `date` and computes the free slots.
// Accepts a transaction client so bookings can run it under a lock. When moving an
// appointment, pass its id so its current time doesn't block the new one.
export async function findAvailableSlots(
  db: Db,
  professional: BookingSettings,
  durationMinutes: number,
  date: string,
  excludeAppointmentId?: string,
): Promise<Slot[]> {
  const { id, timezone, bufferMinutes, maxAppointmentsPerDay } = professional;
  const { firstDay, lastDay } = bookingWindow(timezone);
  if (date < firstDay || date > lastDay) return [];

  const dayStart = zonedTimeToUtc(date, 0, timezone);
  const nextDayStart = zonedTimeToUtc(addDays(date, 1), 0, timezone);
  const bufferMs = bufferMinutes * 60_000;

  const [blocks, timeOff, appointments] = await Promise.all([
    db.availability.findMany({
      where: { professionalId: id, weekday: weekdayOf(date) },
      select: { startMinute: true, endMinute: true },
    }),
    db.timeOff.findFirst({
      where: { professionalId: id, startDate: { lte: new Date(date) }, endDate: { gte: new Date(date) } },
      select: { id: true },
    }),
    // Includes neighbors close enough to the day to matter for the buffer.
    db.appointment.findMany({
      where: {
        professionalId: id,
        status: "CONFIRMED",
        id: excludeAppointmentId ? { not: excludeAppointmentId } : undefined,
        startsAt: { lt: new Date(nextDayStart.getTime() + bufferMs) },
        endsAt: { gt: new Date(dayStart.getTime() - bufferMs) },
      },
      select: { startsAt: true, endsAt: true },
    }),
  ]);

  const bookedThatDay = appointments.filter((a) => a.startsAt >= dayStart && a.startsAt < nextDayStart).length;
  if (timeOff || (maxAppointmentsPerDay !== null && bookedThatDay >= maxAppointmentsPerDay)) return [];

  return computeSlots({
    date,
    timeZone: timezone,
    blocks,
    durationMinutes,
    bufferMinutes,
    appointments,
    notBefore: new Date(Date.now() + MIN_NOTICE_MINUTES * 60_000),
  });
}

// The free slot starting exactly at `startsAt`, if there is one.
export async function findSlotAt(
  db: Db,
  professional: BookingSettings,
  durationMinutes: number,
  startsAt: Date,
  excludeAppointmentId?: string,
): Promise<Slot | undefined> {
  const date = dateIn(professional.timezone, startsAt);
  const slots = await findAvailableSlots(db, professional, durationMinutes, date, excludeAppointmentId);
  return slots.find((slot) => slot.startsAt.getTime() === startsAt.getTime());
}

function formatMinutes(minutes: number) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}
