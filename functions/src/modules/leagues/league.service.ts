/**
 * Weekly leagues of up to 30 people per tier. You join this week's league with your first XP of the week;
 * last week's rank decides your tier. leagues/{id} = {week, tier, members}; leagueOpen/{week}_{tier} points
 * at the league that still has room.
 */
import { FieldValue } from "firebase-admin/firestore";
import { addDays, parseDay } from "../../core/dates";
import { col } from "../../infra/collections";
import { db } from "../../infra/firebase";
import { streakOf } from "../activity/streaks";
import { ProfileDoc, hueFor, photoOf } from "../profiles/profile.model";
import { getProfiles, profileRef } from "../profiles/profile.repo";
import { DEMOTE, DEMOTE_MIN_MEMBERS, LEAGUE_SIZE, PROMOTE, TIERS, outcome, ranked, weekXP } from "./league.logic";

type LeagueRef = NonNullable<ProfileDoc["league"]>;

/** Last week's result for this person. */
async function lastWeek(prev: LeagueRef, uid: string): Promise<{ tier: number; result: string | null }> {
  const lg = await col.leagues().doc(prev.id).get();
  if (!lg.exists) return { tier: prev.tier, result: null };
  const members = (lg.get("members") ?? []) as string[];
  return outcome(ranked(members, await getProfiles(members), prev.week), uid, prev.tier);
}

/** Joins an open league of this tier for the week, or opens a new one. */
async function join(uid: string, week: string, tier: number): Promise<string> {
  const openRef = col.leagueOpen().doc(`${week}_${tier}`);
  return db().runTransaction(async (tx) => {
    const open = await tx.get(openRef);
    let id = open.exists ? (open.get("id") as string) : "";
    if (id) {
      const lg = await tx.get(col.leagues().doc(id));
      if (!lg.exists || ((lg.get("members") ?? []) as string[]).length >= LEAGUE_SIZE) id = "";
    }
    if (!id) {
      id = col.leagues().doc().id;
      tx.set(col.leagues().doc(id), { week, tier, members: [uid], createdAt: FieldValue.serverTimestamp() });
      tx.set(openRef, { id });
    } else {
      tx.update(col.leagues().doc(id), { members: FieldValue.arrayUnion(uid) });
    }
    return id;
  });
}

export async function leagueStatus(uid: string, weekStart: unknown, today: unknown) {
  const week = parseDay(weekStart);
  const day = String(today ?? "");
  const ref = profileRef(uid);
  const me = ((await ref.get()).data() ?? {}) as ProfileDoc;
  let current = me.league;

  if (!current || current.week !== week) {
    let tier = current?.tier ?? 0;
    let result: string | null = null;
    if (current && current.week === addDays(week, -7)) ({ tier, result } = await lastWeek(current, uid));
    else if (current) tier = Math.max(0, tier - 1); // skipped a whole week
    if (weekXP(me, week) <= 0) {
      return { joined: false, tier, tierName: TIERS[tier], week, previous: result, members: [] };
    }
    current = { id: await join(uid, week, tier), tier, week, result };
    await ref.set({ league: current }, { merge: true });
  }

  const lg = await col.leagues().doc(current.id).get();
  const members = (lg.get("members") ?? [uid]) as string[];
  const ps = await getProfiles(members);
  return {
    joined: true,
    tier: current.tier,
    tierName: TIERS[current.tier],
    week,
    previous: current.result ?? null,
    promote: current.tier < TIERS.length - 1 ? PROMOTE : 0,
    demote: current.tier > 0 && members.length >= DEMOTE_MIN_MEMBERS ? DEMOTE : 0,
    members: ranked(members, ps, week).map((r) => {
      const p = ps.get(r.uid);
      return {
        uid: r.uid, xp: r.xp, me: r.uid === uid, name: p?.name ?? "", hue: p?.hue ?? hueFor(r.uid), photo: photoOf(p),
        streak: streakOf(p?.activity ?? {}, day, p?.frozen ?? []),
      };
    }),
  };
}
