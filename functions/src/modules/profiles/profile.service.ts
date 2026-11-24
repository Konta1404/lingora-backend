import { FieldValue, DocumentData } from "firebase-admin/firestore";
import { AppError } from "../../core/errors";
import { parseDay, todayUTC, Day } from "../../core/dates";
import { clip } from "../../core/text";
import { streakOf } from "../activity/streaks";
import { countFriends, withRelations } from "../friends/friendship.repo";
import { TIERS } from "../leagues/league.logic";
import { claimHandle } from "./handles";
import { DEFAULT_NAME, ProfileDoc, emailHash, hueFor, normalizeHandle, sharesActivity, slugifyName, toDTO } from "./profile.model";
import { profileRef, uidForHandle } from "./profile.repo";

/** Creates the profile on first sign-in (with a username) and keeps name, languages and email hash fresh. */
export async function syncProfile(uid: string, email: string | undefined, d: { name?: unknown; langs?: unknown }) {
  const ref = profileRef(uid);
  const snap = await ref.get();
  const name = clip(d.name, 60) || snap.get("name") || DEFAULT_NAME;
  const langs = Array.isArray(d.langs) ? d.langs : [];
  const update: DocumentData = {
    name,
    langs: langs.map((l) => clip(l, 40)).slice(0, 12),
    updatedAt: FieldValue.serverTimestamp(),
  };
  // Lets friends find each other from their contacts without the server storing anyone's email.
  if (email) update.emailHash = emailHash(email);
  if (!snap.exists) {
    update.handle = await claimHandle(uid, slugifyName(name));
    update.hue = hueFor(uid);
    update.activity = {};
    update.createdAt = FieldValue.serverTimestamp();
  }
  await ref.set(update, { merge: true });
  const p = (await ref.get()).data() as ProfileDoc;
  return { handle: p.handle as string, hue: p.hue as number };
}

export async function setPrivacy(uid: string, shareActivity: boolean) {
  await profileRef(uid).set({ shareActivity }, { merge: true });
  return { shareActivity };
}

/** Someone's profile by username: just enough to identify them. */
export async function profileByHandle(handle: unknown) {
  const uid = await uidForHandle(normalizeHandle(handle));
  if (!uid) return null;
  const p = await profileRef(uid).get();
  return p.exists ? { uid: p.id, name: p.get("name") as string, handle: p.get("handle") as string } : null;
}

/** Resolves {uid} or {handle} from a request to a uid ("" if neither matches). */
export async function resolveUser(d: { uid?: unknown; handle?: unknown }): Promise<string> {
  const uid = clip(d.uid, 128);
  if (uid) return uid;
  return d.handle ? ((await profileByHandle(d.handle))?.uid ?? "") : "";
}

/** The in-app profile page. Activity and stats are hidden when the person doesn't share them. */
export async function publicProfile(viewer: string, d: { uid?: unknown; handle?: unknown; day: unknown; weekStart: unknown }) {
  const target = await resolveUser(d);
  if (!target) throw new AppError("not-found", "No one with that username.");
  const snap = await profileRef(target).get();
  if (!snap.exists) throw new AppError("not-found", "No one with that username.");
  const p = snap.data() as ProfileDoc;
  const base = toDTO(target, p, parseDay(d.day), parseDay(d.weekStart), viewer);
  const shares = sharesActivity(p) || target === viewer;
  const relation = target === viewer ? "me" : (await withRelations(viewer, [base]))[0].relation;
  return {
    ...base,
    relation,
    friendsCount: await countFriends(target),
    joined: p.createdAt ? p.createdAt.toMillis() : null,
    league: p.league ? p.league.tier : null,
    stats: shares ? (p.stats ?? null) : null,
  };
}

export interface WebProfile {
  name: string;
  handle: string;
  hue: number;
  langs: string[];
  joined: Date | null;
  shares: boolean;
  streak: number;
  totalXP: number;
  league: string | null;
  friendsCount: number;
  lessons: number;
  bestStreak: number;
  achievements: number;
}

/** What the shared /u/<handle> page shows: the same numbers as the in-app profile, minus anything private. */
export async function webProfile(handle: string, today: Day = todayUTC()): Promise<WebProfile | null> {
  const found = await profileByHandle(handle);
  if (!found) return null;
  const p = ((await profileRef(found.uid).get()).data() ?? {}) as ProfileDoc;
  const shares = sharesActivity(p);
  const stats = shares ? p.stats : undefined;
  return {
    name: p.name ?? DEFAULT_NAME,
    handle: p.handle ?? handle,
    hue: p.hue ?? hueFor(found.uid),
    langs: p.langs ?? [],
    joined: p.createdAt ? p.createdAt.toDate() : null,
    shares,
    streak: streakOf(shares ? (p.activity ?? {}) : {}, today, shares ? (p.frozen ?? []) : []),
    totalXP: Number(stats?.totalXP ?? 0),
    league: p.league ? (TIERS[p.league.tier] ?? null) : null,
    friendsCount: await countFriends(found.uid),
    lessons: Number(stats?.lessons ?? 0),
    bestStreak: Number(stats?.bestStreak ?? 0),
    achievements: Object.values(stats?.achievements ?? {}).filter((v) => v > 0).length,
  };
}
