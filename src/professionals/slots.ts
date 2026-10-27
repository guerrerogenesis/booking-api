import { zonedTimeToUtc } from "./timezone.js";

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

function formatMinutes(minutes: number) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}
