import { describe, expect, it } from "vitest";
import { addDays, canonicalTimeZone, weekdayOf, zonedTimeToUtc } from "./timezone.js";

describe("zonedTimeToUtc", () => {
  it.each([
    ["UTC", "2030-01-07", 540, "2030-01-07T09:00:00.000Z"],
    ["America/Mexico_City", "2030-01-07", 540, "2030-01-07T15:00:00.000Z"],
    // New York is UTC-5 in winter and UTC-4 in summer (DST).
    ["America/New_York", "2030-01-07", 540, "2030-01-07T14:00:00.000Z"],
    ["America/New_York", "2030-07-01", 540, "2030-07-01T13:00:00.000Z"],
    // Late evening local time is already the next day in UTC.
    ["America/Mexico_City", "2030-01-07", 1380, "2030-01-08T05:00:00.000Z"],
    ["Asia/Tokyo", "2030-01-07", 0, "2030-01-06T15:00:00.000Z"],
  ])("%s %s +%i min -> %s", (zone, date, minutes, expected) => {
    expect(zonedTimeToUtc(date, minutes, zone).toISOString()).toBe(expected);
  });
});

describe("canonicalTimeZone", () => {
  it("normalizes casing and rejects offsets and unknown zones", () => {
    expect(canonicalTimeZone("america/mexico_city")).toBe("America/Mexico_City");
    expect(canonicalTimeZone("-06:00")).toBeNull();
    expect(canonicalTimeZone("Mars/Olympus_Mons")).toBeNull();
  });
});

describe("date helpers", () => {
  it("adds days across month and year boundaries", () => {
    expect(addDays("2030-01-31", 1)).toBe("2030-02-01");
    expect(addDays("2030-12-31", 1)).toBe("2031-01-01");
  });

  it("returns the weekday of a calendar date", () => {
    expect(weekdayOf("2030-01-06")).toBe(0); // Sunday
    expect(weekdayOf("2030-01-07")).toBe(1); // Monday
  });
});
