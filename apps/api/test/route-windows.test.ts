import { describe, expect, it } from "vitest";
import {
  dateDetailsInZone,
  generateWindowsForDate,
  isoWeekday,
  matchesWindowRule,
  parseIsoDate,
} from "../src/catalog/route-windows";

describe("route window timezone rules", () => {
  it("validates real calendar dates and ISO weekdays", () => {
    expect(parseIsoDate("2026-08-01")).toBe("2026-08-01");
    expect(isoWeekday("2026-08-01")).toBe(6);
    expect(() => parseIsoDate("2026-02-29")).toThrow("does not exist");
    expect(() => parseIsoDate("08/01/2026")).toThrow("YYYY-MM-DD");
  });

  it("generates exact Asia/Shanghai windows and recognizes them", () => {
    const rule = { startMinute: 17 * 60, endMinute: 18 * 60, windowMinutes: 30 };
    const windows = generateWindowsForDate("2026-08-01", "Asia/Shanghai", rule);
    expect(windows.map((window) => [window.start.toISOString(), window.end.toISOString()])).toEqual(
      [
        ["2026-08-01T09:00:00.000Z", "2026-08-01T09:30:00.000Z"],
        ["2026-08-01T09:30:00.000Z", "2026-08-01T10:00:00.000Z"],
      ],
    );
    expect(
      matchesWindowRule(
        windows[0]?.start ?? new Date(0),
        windows[0]?.end ?? new Date(0),
        "Asia/Shanghai",
        rule,
      ),
    ).toBe(true);
    expect(
      matchesWindowRule(
        new Date("2026-08-01T09:01:00.000Z"),
        new Date("2026-08-01T09:31:00.000Z"),
        "Asia/Shanghai",
        rule,
      ),
    ).toBe(false);
  });

  it("returns local details and omits nonexistent daylight-saving windows", () => {
    expect(dateDetailsInZone(new Date("2026-08-01T09:00:00.000Z"), "Asia/Shanghai")).toEqual({
      date: "2026-08-01",
      weekday: 6,
      minute: 1_020,
    });
    const skipped = generateWindowsForDate("2026-03-08", "America/New_York", {
      startMinute: 120,
      endMinute: 180,
      windowMinutes: 30,
    });
    expect(skipped).toEqual([]);
  });

  it("rejects invalid rules, dates, timestamps, and timezone identifiers", () => {
    expect(() =>
      generateWindowsForDate("2026-08-01", "Asia/Shanghai", {
        startMinute: 100,
        endMinute: 100,
        windowMinutes: 30,
      }),
    ).toThrow("schedule");
    expect(() => dateDetailsInZone(new Date("invalid"), "Asia/Shanghai")).toThrow("date-time");
    expect(() => dateDetailsInZone(new Date(), "Invalid/Timezone")).toThrow();
  });
});
