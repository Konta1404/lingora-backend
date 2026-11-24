/** Challenges between friends: a 7-day duel, a minutes sprint, or following a shared plan together. */
import { FieldValue, DocumentData } from "firebase-admin/firestore";
import { AppError } from "../../core/errors";
import { addDays, parseDay, Day } from "../../core/dates";
import { clip } from "../../core/text";
import { col } from "../../infra/collections";
import { db } from "../../infra/firebase";
import { activeDaysBetween, sumBetween } from "../activity/streaks";
import { requireFriend } from "../friends/friendship.repo";
import { hueFor } from "../profiles/profile.model";
import { getProfiles } from "../profiles/profile.repo";
import { MAX_PLAN_CHARS } from "./plans.service";

export type ChallengeType = "duel" | "sprint" | "plan";
const TYPES: ChallengeType[] = ["duel", "sprint", "plan"];

export interface ChallengeInput {
  type: ChallengeType;
  friends: string[];
  day: string;
  endDay?: string;
  goalMinutes?: number;
  lang?: string;
  plan?: string;
  title?: string;
}

export async function createChallenge(uid: string, d: ChallengeInput) {
  const type = d.type;
  if (!TYPES.includes(type)) throw new AppError("invalid-argument", "Unknown challenge.");
  const invited = [...new Set((d.friends ?? []).map((f) => clip(f, 128)))].filter((f) => f && f !== uid).slice(0, type === "duel" ? 1 : 5);
  if (invited.length === 0) throw new AppError("invalid-argument", "Pick a friend.");
  for (const f of invited) await requireFriend(uid, f);
  const start = parseDay(d.day);
  const doc: DocumentData = {
    type, creator: uid, members: [uid], invited, startDay: start, createdAt: FieldValue.serverTimestamp(),
    endDay: type === "duel" ? addDays(start, 6) : type === "sprint" ? parseDay(d.endDay ?? addDays(start, 6)) : null,
    goalMinutes: type === "sprint" ? Math.max(10, Math.min(600, Number(d.goalMinutes) || 60)) : null,
    lang: clip(d.lang, 40) || null,
    title: clip(d.title, 120) || null,
  };
  if (type === "plan") {
    if (!d.plan || d.plan.length > MAX_PLAN_CHARS) throw new AppError("invalid-argument", "Plan missing.");
    const planRef = await col.sharedPlans().add({ owner: uid, lang: doc.lang, plan: d.plan, createdAt: FieldValue.serverTimestamp() });
    doc.planId = planRef.id;
  }
  const ref = await col.challenges().add(doc);
  return { id: ref.id };
}

export async function respondChallenge(uid: string, id: string, accept: boolean) {
  const ref = col.challenges().doc(clip(id, 64) || "-");
  await db().runTransaction(async (tx) => {
    const c = await tx.get(ref);
    if (!c.exists || !((c.get("invited") as string[]) ?? []).includes(uid)) throw new AppError("not-found", "Invite not found.");
    tx.update(ref, { invited: FieldValue.arrayRemove(uid), ...(accept ? { members: FieldValue.arrayUnion(uid) } : {}) });
  });
  return { ok: true };
}

export async function leaveChallenge(uid: string, id: string) {
  const ref = col.challenges().doc(clip(id, 64) || "-");
  if (!(await ref.get()).exists) throw new AppError("not-found", "Challenge not found.");
  await ref.update({ members: FieldValue.arrayRemove(uid), invited: FieldValue.arrayRemove(uid) });
  return { ok: true };
}

/** Challenges the caller is in or invited to, still running or ended in the last 3 days, with standings. */
export async function listChallenges(uid: string, today: Day) {
  const [a, b] = await Promise.all([
    col.challenges().where("members", "array-contains", uid).get(),
    col.challenges().where("invited", "array-contains", uid).get(),
  ]);
  const docs = new Map([...a.docs, ...b.docs].map((d) => [d.id, d]));
  const recent = [...docs.values()].filter((d) => !d.get("endDay") || (d.get("endDay") as string) >= addDays(today, -3));
  const people = await getProfiles(recent.flatMap((d) => [...(d.get("members") as string[]), ...(d.get("invited") as string[])]));
  return recent.map((d) => {
    const c = d.data();
    const members = c.members as string[];
    const rows = members.map((m) => {
      const act = people.get(m)?.activity ?? {};
      const value = c.type === "duel" ? activeDaysBetween(act, c.startDay, c.endDay) : c.type === "sprint" ? sumBetween(act, c.startDay, c.endDay) : 0;
      return { uid: m, name: people.get(m)?.name ?? "", hue: people.get(m)?.hue ?? hueFor(m), value };
    });
    return {
      id: d.id,
      type: c.type as ChallengeType,
      creator: c.creator as string,
      creatorName: people.get(c.creator)?.name ?? "",
      invitedMe: (c.invited as string[]).includes(uid),
      pending: (c.invited as string[]).map((u) => people.get(u)?.name ?? ""),
      startDay: c.startDay as string,
      endDay: (c.endDay as string) ?? null,
      goal: c.type === "duel" ? 7 : (c.goalMinutes as number) ?? 0,
      lang: (c.lang as string) ?? null,
      title: (c.title as string) ?? null,
      planId: (c.planId as string) ?? null,
      rows,
    };
  }).sort((x, y) => (y.startDay ?? "").localeCompare(x.startDay ?? ""));
}
