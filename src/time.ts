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

// "3", "3d", "3 days", "1w", "2 weeks" -> days (1..60)
export function parseGap(input: string): number | null {
  const m = input.trim().toLowerCase().match(/^(\d{1,2})\s*(d|day|days|w|wk|week|weeks)?$/);
  if (!m) return null;
  const n = Number(m[1]) * (m[2]?.startsWith("w") ? 7 : 1);
  return n >= 1 && n <= 60 ? n : null;
}
