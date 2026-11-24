/** Weekly league rules. Pure; unit-tested. */
import { addDays, Day } from "../../core/dates";
import { sumBetween } from "../activity/streaks";
import { ProfileDoc } from "../profiles/profile.model";

export const TIERS = ["Bronze", "Silver", "Gold", "Sapphire", "Ruby", "Emerald", "Amethyst", "Pearl", "Obsidian", "Diamond"];
export const LEAGUE_SIZE = 30;
export const PROMOTE = 7;
export const DEMOTE = 5;
/** Demotion only applies in leagues at least this big. */
export const DEMOTE_MIN_MEMBERS = 10;

export type LeagueResult = "promoted" | "demoted" | "stayed";

/** XP earned in the week that starts on `week`. */
export const weekXP = (p: ProfileDoc | undefined, week: Day) => sumBetween(p?.xpDays ?? {}, week, addDays(week, 6));

export function ranked(memberIds: string[], profiles: Map<string, ProfileDoc>, week: Day) {
  return memberIds.map((uid) => ({ uid, xp: weekXP(profiles.get(uid), week) })).sort((a, b) => b.xp - a.xp);
}

/** Where last week's league leaves you: up (top 7 with XP), down (bottom 5 of a big league, or no XP) or the same. */
export function outcome(order: { uid: string; xp: number }[], uid: string, tier: number): { tier: number; result: LeagueResult } {
  const rank = order.findIndex((r) => r.uid === uid);
  const mine = order[rank];
  if (mine && mine.xp > 0 && rank < PROMOTE && tier < TIERS.length - 1) return { tier: tier + 1, result: "promoted" };
  const size = order.length;
  if (tier > 0 && (!mine || mine.xp === 0 || (size >= DEMOTE_MIN_MEMBERS && rank >= size - DEMOTE))) {
    return { tier: tier - 1, result: "demoted" };
  }
  return { tier, result: "stayed" };
}
