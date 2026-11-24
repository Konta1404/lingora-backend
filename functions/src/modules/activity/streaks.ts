/** Pure activity maths over per-day maps ("YYYY-MM-DD" → minutes or XP). No I/O; unit-tested. */
import { addDays, isDay, Day } from "../../core/dates";

export type DayMap = Record<Day, number>;

const MAX_LOOKBACK = 400;

/** Consecutive active days ending today (or yesterday). A frozen day keeps the streak without adding to it. */
export function streakOf(activity: DayMap, today: Day, frozen: string[] = []): number {
  const ice = new Set(frozen);
  let d = (activity[today] ?? 0) > 0 ? today : addDays(today, -1);
  let n = 0;
  for (let guard = 0; guard < MAX_LOOKBACK; guard++) {
    if ((activity[d] ?? 0) > 0) n++;
    else if (!ice.has(d)) break;
    d = addDays(d, -1);
  }
  return n;
}

/** Days in a row on which both people practised (ending today or yesterday). */
export function pairStreak(a: DayMap, b: DayMap, today: Day): number {
  const both = (d: Day) => (a[d] ?? 0) > 0 && (b[d] ?? 0) > 0;
  let d = both(today) ? today : addDays(today, -1);
  let n = 0;
  while (both(d) && n < MAX_LOOKBACK) {
    n++;
    d = addDays(d, -1);
  }
  return n;
}

/** Sum of the values from `from` (inclusive), up to `to` (inclusive) when given. */
export function sumBetween(map: DayMap, from: Day, to?: Day): number {
  return Object.entries(map).filter(([d]) => d >= from && (!to || d <= to)).reduce((s, [, v]) => s + v, 0);
}

/** Number of active days from `from` up to `to`. */
export function activeDaysBetween(map: DayMap, from: Day, to?: Day): number {
  return Object.entries(map).filter(([d, v]) => d >= from && (!to || d <= to) && v > 0).length;
}

export const STREAK_MILESTONES = [3, 7, 14, 30, 50, 100, 200, 365];
/** The server keeps this many days of history. */
export const HISTORY_DAYS = 90;
/** The app may only (re)report this many recent days. */
export const REPORT_WINDOW_DAYS = 14;

export interface StoredActivity {
  activity: DayMap;
  xpDays: DayMap;
  frozen: string[];
  lastMilestone: number;
}

export interface ActivityReport {
  days?: Record<string, unknown>;
  xpDays?: Record<string, unknown>;
  frozen?: unknown[];
}

/**
 * Merges what the app reports into what's stored. The app sends its own per-day totals, and the server
 * keeps the larger value per day, so retries and several devices never double-count. Old days are pruned.
 */
export function mergeReport(stored: StoredActivity, report: ActivityReport, today: Day) {
  const inWindow = (k: string) => isDay(k) && k <= addDays(today, 1) && k >= addDays(today, -REPORT_WINDOW_DAYS);
  const cutoff = addDays(today, -HISTORY_DAYS);

  const activity = { ...stored.activity };
  for (const [k, v] of Object.entries(report.days ?? {})) {
    if (inWindow(k)) activity[k] = Math.max(activity[k] ?? 0, Math.max(0, Math.min(1440, Math.round(Number(v) || 0))));
  }
  const xpDays = { ...stored.xpDays };
  for (const [k, v] of Object.entries(report.xpDays ?? {})) {
    if (inWindow(k)) xpDays[k] = Math.max(xpDays[k] ?? 0, Math.min(5000, Math.round(Number(v) || 0)));
  }
  for (const map of [activity, xpDays]) for (const k of Object.keys(map)) if (k < cutoff) delete map[k];

  const reportedFrozen = (report.frozen ?? []).filter((f): f is string => isDay(f));
  const frozen = [...new Set([...stored.frozen, ...reportedFrozen])].filter((f) => f >= cutoff).sort().slice(-60);

  const streak = streakOf(activity, today, frozen);
  const hit = STREAK_MILESTONES.filter((m) => streak >= m && m > stored.lastMilestone).pop();
  const milestone = hit && streak === hit ? hit : null;
  return { activity, xpDays, frozen, streak, milestone };
}
