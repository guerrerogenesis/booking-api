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

// Today's date as YYYY-MM-DD in the given zone.
export function todayIn(timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(),
  );
}
