import { DateTime, IANAZone } from "luxon";

const ZONES: string[] = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];

const ALIASES: Record<string, string> = {
  nigeria: "Africa/Lagos",
  abuja: "Africa/Lagos",
  "port harcourt": "Africa/Lagos",
  ibadan: "Africa/Lagos",
  ghana: "Africa/Accra",
  kenya: "Africa/Nairobi",
  "south africa": "Africa/Johannesburg",
  uk: "Europe/London",
  "united kingdom": "Europe/London",
  england: "Europe/London",
  india: "Asia/Kolkata",
  delhi: "Asia/Kolkata",
  mumbai: "Asia/Kolkata",
  "new york": "America/New_York",
  nyc: "America/New_York",
  "san francisco": "America/Los_Angeles",
  sf: "America/Los_Angeles",
  "los angeles": "America/Los_Angeles",
  la: "America/Los_Angeles",
  texas: "America/Chicago",
  germany: "Europe/Berlin",
  france: "Europe/Paris",
  canada: "America/Toronto",
  toronto: "America/Toronto",
  dubai: "Asia/Dubai",
  uae: "Asia/Dubai",
  singapore: "Asia/Singapore",
  japan: "Asia/Tokyo",
  australia: "Australia/Sydney",
  wat: "Africa/Lagos",
  est: "America/New_York",
  pst: "America/Los_Angeles",
  cet: "Europe/Paris",
};

// Accepts an IANA name, a city or country we know, or a UTC offset such as
// "UTC+1", "GMT-5" or "+05:30". Returns an IANA zone or a Luxon fixed-offset
// zone ("UTC+1"), or null when it cannot tell.
export function resolveZone(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();

  const exact = ZONES.find((z) => z.toLowerCase() === lower);
  if (exact) return exact;
  if (IANAZone.isValidZone(raw) && raw.includes("/")) return raw;

  if (ALIASES[lower]) return ALIASES[lower]!;

  const offset = lower.match(/^(?:utc|gmt)?\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/);
  if (offset) {
    const h = Number(offset[2]);
    const m = Number(offset[3] ?? 0);
    if (h > 14 || m >= 60) return null;
    const name = `UTC${offset[1]}${h}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
    return DateTime.now().setZone(name).isValid ? name : null;
  }
  if (lower === "utc" || lower === "gmt") return "UTC";

  const city = lower.replace(/\s+/g, "_");
  const byCity = ZONES.find((z) => z.toLowerCase().split("/").pop() === city);
  return byCity ?? null;
}

export function isValidZone(zone: string) {
  return DateTime.now().setZone(zone).isValid;
}

// "9", "9am", "9:30 pm", "21:00", "noon", "morning" -> HH:mm
export function parseTimeOfDay(input: string): string | null {
  const s = input.trim().toLowerCase().replace(/\./g, "");
  const named: Record<string, string> = { morning: "09:00", noon: "12:00", midday: "12:00", afternoon: "14:00", evening: "19:00", night: "21:00", tonight: "20:00" };
  if (named[s]) return named[s]!;
  const m = s.match(/^(?:at\s+)?(\d{1,2})(?:[:h](\d{2}))?\s*(am|pm|a|p)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ampm = m[3];
  if (min > 59) return null;
  if (ampm) {
    if (h < 1 || h > 12) return null;
    if (ampm.startsWith("p") && h !== 12) h += 12;
    if (ampm.startsWith("a") && h === 12) h = 0;
  } else if (h > 23) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

// The next 14 days as "2026-10-08 Thursday" lines, so the model resolves
// "Thursday" or "next week" against real dates instead of guessing.
export function calendarContext(now: Date, zone: string): string {
  const today = DateTime.fromJSDate(now).setZone(zone).startOf("day");
  return Array.from({ length: 14 }, (_, i) => {
    const d = today.plus({ days: i });
    const tag = i === 0 ? " (today)" : i === 1 ? " (tomorrow)" : "";
    return `${d.toISODate()} ${d.toFormat("cccc")}${tag}`;
  }).join("\n");
}

export function localNow(now: Date, zone: string) {
  return DateTime.fromJSDate(now).setZone(zone).toFormat("yyyy-LL-dd HH:mm cccc");
}

export function toInstant(date: string, time: string, zone: string): Date | null {
  const dt = DateTime.fromISO(`${date}T${time}`, { zone });
  return dt.isValid ? dt.toJSDate() : null;
}

export function isIsoDate(s: string | undefined | null): s is string {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && DateTime.fromISO(s).isValid;
}

export function formatWhen(when: Date, zone: string, now?: Date): string {
  const dt = DateTime.fromJSDate(when).setZone(zone);
  const sameYear = !now || DateTime.fromJSDate(now).setZone(zone).year === dt.year;
  return dt.toFormat(sameYear ? "cccc d LLL, HH:mm" : "cccc d LLL yyyy, HH:mm");
}

export function localTime(when: Date, zone: string): string {
  return DateTime.fromJSDate(when).setZone(zone).toFormat("HH:mm");
}

export function formatDay(date: string, zone: string): string {
  return DateTime.fromISO(date, { zone }).toFormat("cccc d LLL");
}

export function formatDate(when: Date, zone: string): string {
  return DateTime.fromJSDate(when).setZone(zone).toFormat("d LLL yyyy");
}

export const DAY_MS = 86_400_000;
export const addDays = (d: Date, days: number) => new Date(d.getTime() + days * DAY_MS);
export const addHours = (d: Date, hours: number) => new Date(d.getTime() + hours * 3_600_000);

// Tomorrow at the given local time, used by "snooze until tomorrow".
export function tomorrowAt(now: Date, zone: string, time = "09:00"): Date {
  const [h, m] = time.split(":").map(Number);
  return DateTime.fromJSDate(now).setZone(zone).plus({ days: 1 }).set({ hour: h, minute: m, second: 0, millisecond: 0 }).toJSDate();
}

export const MINUTE_MS = 60_000;
export const MAX_CHECK_BACK_DAYS = 60;

// When to check back on a save, from what the user typed:
// "3" (days), "5 min", "2 hours", "1h 30m", "3 days", "2 weeks", "in 45 minutes",
// or a clock time like "6pm", "18:30", "tomorrow 9am" (next occurrence, local).
// Returns null when it cannot be read or is outside 1 minute .. 60 days.
export function parseCheckBack(input: string, now: Date, zone: string): Date | null {
  const s = input.trim().toLowerCase().replace(/^(in|after)\s+/, "").replace(/\s+from now$/, "");
  if (/^\d{1,2}$/.test(s)) return inRange(now, Number(s) * DAY_MS);

  const units: Record<string, number> = { m: MINUTE_MS, h: 3_600_000, d: DAY_MS, w: 7 * DAY_MS };
  const unit = (u: string) => (u.startsWith("mi") || u === "m" ? "m" : u.startsWith("h") ? "h" : u.startsWith("d") ? "d" : u.startsWith("w") ? "w" : null);
  const part = /(\d+(?:\.\d+)?|an?|one|half an?)\s*(m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?)\b/g;
  const rest = s.replace(part, "").replace(/\b(and|,)\b/g, "").replace(/[,\s]+/g, "");
  if (rest === "") {
    let ms = 0;
    for (const m of s.matchAll(part)) {
      const n = m[1] === "a" || m[1] === "an" || m[1] === "one" ? 1 : m[1]!.startsWith("half") ? 0.5 : Number(m[1]);
      ms += n * units[unit(m[2]!)!]!;
    }
    if (ms > 0) return inRange(now, ms);
  }

  const tomorrow = /^tomorrow\b/.test(s);
  const time = parseTimeOfDay(s.replace(/^(tomorrow|today)\s*(at\s+)?/, "")) ?? (tomorrow && s === "tomorrow" ? "09:00" : null);
  if (!time) return null;
  const [h, mi] = time.split(":").map(Number);
  let at = DateTime.fromJSDate(now).setZone(zone).set({ hour: h, minute: mi, second: 0, millisecond: 0 });
  if (tomorrow) at = at.plus({ days: 1 });
  else if (at.toMillis() <= now.getTime()) at = at.plus({ days: 1 });
  return inRange(now, at.toMillis() - now.getTime());
}

function inRange(now: Date, ms: number): Date | null {
  return ms >= MINUTE_MS && ms <= MAX_CHECK_BACK_DAYS * DAY_MS ? new Date(now.getTime() + Math.round(ms)) : null;
}

// "5 minutes", "2 hours 30 minutes", "3 days" for a short "in ..." note.
export function formatIn(ms: number): string {
  const mins = Math.round(ms / MINUTE_MS);
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (mins < 60) return plural(Math.max(mins, 1), "minute");
  if (mins < 24 * 60) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `${plural(h, "hour")} ${plural(m, "minute")}` : plural(h, "hour");
  }
  const days = Math.round(mins / (24 * 60));
  return days % 7 === 0 ? plural(days / 7, "week") : plural(days, "day");
}

// Local hour (0-23) of an instant.
export function localHour(when: Date, zone: string): number {
  return DateTime.fromJSDate(when).setZone(zone).hour;
}

// The same local day as `when`, at hour:00.
export function atLocalHour(when: Date, zone: string, hour: number): Date {
  return DateTime.fromJSDate(when).setZone(zone).set({ hour, minute: 0, second: 0, millisecond: 0 }).toJSDate();
}

// "3", "3d", "3 days", "1w", "2 weeks" -> days (1..60)
export function parseGap(input: string): number | null {
  const m = input.trim().toLowerCase().match(/^(\d{1,2})\s*(d|day|days|w|wk|week|weeks)?$/);
  if (!m) return null;
  const n = Number(m[1]) * (m[2]?.startsWith("w") ? 7 : 1);
  return n >= 1 && n <= 60 ? n : null;
}
