/** The stored profile document and the public shape other people see. Pure. */
import { createHash } from "crypto";
import { addDays, Day } from "../../core/dates";
import { DayMap, streakOf, sumBetween } from "../activity/streaks";

/** profiles/{uid} */
export interface ProfileDoc {
  name?: string;
  handle?: string;
  hue?: number;
  langs?: string[];
  emailHash?: string;
  activity?: DayMap;
  xpDays?: DayMap;
  frozen?: string[];
  lastActiveDay?: string;
  lastMilestone?: number;
  shareActivity?: boolean;
  photoVersion?: number;
  stats?: ProfileStats;
  league?: { id: string; tier: number; week: string; result?: string | null };
  createdAt?: { toMillis(): number; toDate(): Date };
}

export interface ProfileStats {
  totalXP: number;
  bestStreak: number;
  lessons: number;
  words: number;
  stories: number;
  achievements: Record<string, number>;
}

export interface ProfileDTO {
  uid: string;
  name: string;
  handle: string;
  hue: number;
  langs: string[];
  streak: number;
  weekMinutes: number;
  weekXP: number;
  practisedToday: boolean;
  /** False when the person hides their activity (their stats are then zero for others). */
  sharesActivity: boolean;
  /** Profile photo version (0 = none); the image is at GET /avatar/<uid>?v=<photo>. */
  photo: number;
}

export const DEFAULT_NAME = "Lingora learner";

/** A stable avatar colour for people without one stored. */
export function hueFor(uid: string): number {
  return parseInt(createHash("sha256").update(uid).digest("hex").slice(0, 4), 16) % 360;
}

export const sharesActivity = (p: ProfileDoc | undefined) => p?.shareActivity !== false;

export const photoOf = (p: ProfileDoc | undefined) => p?.photoVersion ?? 0;

export function toDTO(uid: string, p: ProfileDoc | undefined, today: Day, weekStart: Day, viewer: string): ProfileDTO {
  const visible = sharesActivity(p) || uid === viewer;
  const activity = visible ? (p?.activity ?? {}) : {};
  return {
    sharesActivity: sharesActivity(p),
    photo: photoOf(p),
    uid,
    name: p?.name ?? DEFAULT_NAME,
    handle: p?.handle ?? "",
    hue: p?.hue ?? hueFor(uid),
    langs: p?.langs ?? [],
    streak: streakOf(activity, today, visible ? (p?.frozen ?? []) : []),
    weekMinutes: sumBetween(activity, weekStart),
    weekXP: visible ? sumBetween(p?.xpDays ?? {}, weekStart, addDays(weekStart, 6)) : 0,
    practisedToday: (activity[today] ?? 0) > 0,
  };
}

/** Lifetime numbers the app reports (the server itself only keeps 90 days of activity). */
export function cleanStats(raw: Record<string, unknown>): ProfileStats {
  const n = (k: string) => Math.max(0, Math.min(10_000_000, Math.round(Number(raw[k]) || 0)));
  const achievements: Record<string, number> = {};
  for (const [k, v] of Object.entries((raw.achievements ?? {}) as Record<string, unknown>).slice(0, 20)) {
    achievements[String(k).trim().slice(0, 20)] = Math.max(0, Math.min(10, Math.round(Number(v) || 0)));
  }
  return { totalXP: n("totalXP"), bestStreak: n("bestStreak"), lessons: n("lessons"), words: n("words"), stories: n("stories"), achievements };
}

/** "José Müller" → "jose.muller": the default username. */
export function slugifyName(name: string): string {
  const base = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "");
  return (base || "learner").slice(0, 16);
}

export const HANDLE = /^[a-z0-9._]{3,20}$/;

/** "@Vesko.K" → "vesko.k" (not validated). */
export const normalizeHandle = (s: unknown) => String(s ?? "").trim().slice(0, 20).toLowerCase().replace(/^@/, "");

export const emailHash = (email: string) => createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
