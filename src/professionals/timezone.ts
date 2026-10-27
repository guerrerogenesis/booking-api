// Returns the canonical IANA name (e.g. "america/mexico_city" -> "America/Mexico_City"),
// or null if the zone doesn't exist.
export function canonicalTimeZone(timeZone: string): string | null {
  // Intl accepts offsets like "-06:00", but PostgreSQL reads them with the sign inverted
  // (POSIX style), so only zone names are allowed.
  if (!/^[A-Za-z]/.test(timeZone)) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

// Offset of the zone from UTC at the given instant, in ms (e.g. -6h for Mexico City).
function offsetMs(timeZone: string, instant: number): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(instant)
      .map((part) => [part.type, Number(part.value)]),
  );
  const wallClockAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return wallClockAsUtc - Math.floor(instant / 1000) * 1000;
}

// Converts a local wall-clock time (YYYY-MM-DD + minutes from midnight) to a UTC instant.
export function zonedTimeToUtc(date: string, minutes: number, timeZone: string): Date {
  const wallClock = Date.parse(`${date}T00:00:00Z`) + minutes * 60_000;
  const guess = wallClock - offsetMs(timeZone, wallClock);
  // Re-check with the offset at the guessed instant, which differs around DST changes.
  return new Date(wallClock - offsetMs(timeZone, guess));
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

// 0 = Sunday ... 6 = Saturday, for a calendar date.
export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

// The local date (YYYY-MM-DD) of an instant in the given zone.
export function dateIn(timeZone: string, instant: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    instant,
  );
}

export function todayIn(timeZone: string): string {
  return dateIn(timeZone, new Date());
}

// "YYYY-MM-DD HH:MM" in the given zone, for messages.
export function formatLocal(instant: Date, timeZone: string): string {
  const time = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" });
  return `${dateIn(timeZone, instant)} ${time.format(instant)}`;
}
