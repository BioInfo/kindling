// Calendar dates in the owner's timezone. new Date().toISOString() and SQLite
// date('now') are UTC, so from 8pm ET (7pm in winter) "today" is already
// tomorrow and "this month" flips early on the last evening of a month.
// Every date here is a plain "YYYY-MM-DD" string; arithmetic on those strings
// runs in UTC, where a day is always 24h, so DST never shifts a result.
export const LOCAL_TZ = process.env.TZ_LOCAL || "America/New_York";

const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: LOCAL_TZ, year: "numeric", month: "2-digit", day: "2-digit" });

// Local calendar date of an instant (default: now).
export function todayLocal(at: Date = new Date()): string {
  return fmt.format(at); // en-CA formats as YYYY-MM-DD
}

export function monthLocal(at: Date = new Date()): string {
  return todayLocal(at).slice(0, 7);
}

export function yearLocal(at: Date = new Date()): number {
  return Number(todayLocal(at).slice(0, 4));
}

export function addDays(date: string, days: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + Math.round(days));
  return d.toISOString().slice(0, 10);
}

export function daysAgo(n: number): string {
  return addDays(todayLocal(), -n);
}

// Whole days from a to b (positive when b is later).
export function daysBetween(a: string, b: string): number {
  return Math.round((+new Date(b + "T00:00:00Z") - +new Date(a + "T00:00:00Z")) / 86400000);
}

// "YYYY-MM" shifted by n months.
export function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}

// First day of the month holding a date ("YYYY-MM-01").
export function startOfMonth(date: string): string {
  return date.slice(0, 7) + "-01";
}
