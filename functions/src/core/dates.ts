import { AppError } from "./errors";

/** Days are plain "YYYY-MM-DD" strings in the learner's local calendar, as sent by the app. */
export type Day = string;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const isDay = (s: unknown): s is Day => typeof s === "string" && DAY.test(s);

export function parseDay(s: unknown): Day {
  const d = String(s ?? "");
  if (!DAY.test(d)) throw new AppError("invalid-argument", "Bad date.");
  return d;
}

export function addDays(d: Day, n: number): Day {
  const t = new Date(`${d}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

export const todayUTC = (): Day => new Date().toISOString().slice(0, 10);
