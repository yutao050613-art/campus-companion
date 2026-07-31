export interface LocalWindowRule {
  readonly startMinute: number;
  readonly endMinute: number;
  readonly windowMinutes: number;
}

export interface ZonedDateDetails {
  readonly date: string;
  readonly weekday: number;
  readonly minute: number;
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;

export function parseIsoDate(value: string): string {
  const match = value.match(DATE_PATTERN);
  if (match === null) throw new RangeError("date must use YYYY-MM-DD");
  const year = Number.parseInt(match[1] ?? "", 10);
  const month = Number.parseInt(match[2] ?? "", 10);
  const day = Number.parseInt(match[3] ?? "", 10);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new RangeError("date does not exist");
  }
  return value;
}

export function dateDetailsInZone(value: Date, timezone: string): ZonedDateDetails {
  const parts = formattedParts(value, timezone);
  const date = `${parts.year.toString().padStart(4, "0")}-${parts.month
    .toString()
    .padStart(2, "0")}-${parts.day.toString().padStart(2, "0")}`;
  return {
    date,
    weekday: isoWeekday(date),
    minute: parts.hour * 60 + parts.minute,
  };
}

export function generateWindowsForDate(
  date: string,
  timezone: string,
  rule: LocalWindowRule,
): readonly { readonly start: Date; readonly end: Date }[] {
  parseIsoDate(date);
  validateRule(rule);
  const windows: { start: Date; end: Date }[] = [];
  for (
    let minute = rule.startMinute;
    minute + rule.windowMinutes <= rule.endMinute;
    minute += rule.windowMinutes
  ) {
    const start = zonedLocalMinuteToDate(date, minute, timezone);
    const end = zonedLocalMinuteToDate(date, minute + rule.windowMinutes, timezone);
    if (start !== null && end !== null && end > start) windows.push({ start, end });
  }
  return windows;
}

export function matchesWindowRule(
  start: Date,
  end: Date,
  timezone: string,
  rule: LocalWindowRule,
): boolean {
  validateRule(rule);
  const localStart = dateDetailsInZone(start, timezone);
  const localEnd = dateDetailsInZone(end, timezone);
  return (
    localStart.date === localEnd.date &&
    localStart.minute >= rule.startMinute &&
    localStart.minute + rule.windowMinutes <= rule.endMinute &&
    (localStart.minute - rule.startMinute) % rule.windowMinutes === 0 &&
    localEnd.minute - localStart.minute === rule.windowMinutes &&
    end.getTime() - start.getTime() === rule.windowMinutes * 60_000
  );
}

export function isoWeekday(date: string): number {
  const parsed = parseIsoDate(date);
  const weekday = new Date(`${parsed}T00:00:00.000Z`).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

function zonedLocalMinuteToDate(date: string, minute: number, timezone: string): Date | null {
  const match = date.match(DATE_PATTERN);
  if (match === null) return null;
  const year = Number.parseInt(match[1] ?? "", 10);
  const month = Number.parseInt(match[2] ?? "", 10);
  const day = Number.parseInt(match[3] ?? "", 10);
  const targetHour = Math.floor(minute / 60);
  const targetMinute = minute % 60;
  const targetAsUtc = Date.UTC(year, month - 1, day, targetHour, targetMinute);
  let candidate = targetAsUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = formattedParts(new Date(candidate), timezone);
    const currentAsUtc = Date.UTC(
      current.year,
      current.month - 1,
      current.day,
      current.hour,
      current.minute,
    );
    const adjustment = targetAsUtc - currentAsUtc;
    candidate += adjustment;
    if (adjustment === 0) break;
  }
  const verified = formattedParts(new Date(candidate), timezone);
  if (
    verified.year !== year ||
    verified.month !== month ||
    verified.day !== day ||
    verified.hour !== targetHour ||
    verified.minute !== targetMinute
  ) {
    return null;
  }
  return new Date(candidate);
}

function formattedParts(
  value: Date,
  timezone: string,
): {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
} {
  if (!Number.isFinite(value.getTime())) throw new RangeError("date-time is invalid");
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const values = new Map<string, string>(
    formatter.formatToParts(value).map((part) => [part.type, part.value]),
  );
  const number = (type: string): number => Number.parseInt(values.get(type) ?? "", 10);
  const result = {
    year: number("year"),
    month: number("month"),
    day: number("day"),
    hour: number("hour"),
    minute: number("minute"),
  };
  if (Object.values(result).some((part) => !Number.isInteger(part))) {
    throw new RangeError("timezone formatting failed");
  }
  return result;
}

function validateRule(rule: LocalWindowRule): void {
  if (
    !Number.isInteger(rule.startMinute) ||
    !Number.isInteger(rule.endMinute) ||
    !Number.isInteger(rule.windowMinutes) ||
    rule.startMinute < 0 ||
    rule.endMinute > 1_440 ||
    rule.startMinute >= rule.endMinute ||
    rule.windowMinutes < 5 ||
    rule.windowMinutes > 120
  ) {
    throw new RangeError("route schedule is invalid");
  }
}
