/**
 * Lingora social layer: profiles, usernames, friends, activity feed, cheers, nudges,
 * challenges, shared plans, friend chat and devices. All data is server-only in Firestore
 * (clients go through these functions), so firestore.rules can keep denying direct access.
 */
import { createHash, randomUUID } from "crypto";
import { getFirestore, FieldValue, FieldPath, Timestamp, DocumentData } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";

const db = () => getFirestore();
const profiles = () => db().collection("profiles");
const handles = () => db().collection("handles");
const friendships = () => db().collection("friendships");
const challenges = () => db().collection("challenges");
const sharedPlans = () => db().collection("sharedPlans");

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const HANDLE = /^[a-z0-9._]{3,20}$/;

export interface ProfileDTO {
  uid: string; name: string; handle: string; hue: number; langs: string[];
  streak: number; weekMinutes: number; practisedToday: boolean;
}

function clip(s: unknown, n: number): string {
  return String(s ?? "").trim().slice(0, n);
}

function day(s: unknown): string {
  const d = String(s ?? "");
  if (!DAY.test(d)) throw new HttpsError("invalid-argument", "Bad date.");
  return d;
}

function addDays(d: string, n: number): string {
  const t = new Date(`${d}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

export const pairId = (a: string, b: string) => [a, b].sort().join("_");

function hueFor(uid: string): number {
  return parseInt(createHash("sha256").update(uid).digest("hex").slice(0, 4), 16) % 360;
}

/** Consecutive active days ending today (or yesterday, if today has no practice yet). */
export function streakOf(activity: Record<string, number>, today: string): number {
  let d = (activity[today] ?? 0) > 0 ? today : addDays(today, -1);
  let n = 0;
  while ((activity[d] ?? 0) > 0) {
    n++;
    d = addDays(d, -1);
  }
  return n;
}

function minutesSince(activity: Record<string, number>, from: string, to?: string): number {
  return Object.entries(activity).filter(([d]) => d >= from && (!to || d <= to)).reduce((a, [, m]) => a + m, 0);
}

function daysActiveSince(activity: Record<string, number>, from: string, to?: string): number {
  return Object.entries(activity).filter(([d, m]) => d >= from && (!to || d <= to) && m > 0).length;
}

function toDTO(uid: string, p: DocumentData | undefined, today: string, weekStart: string): ProfileDTO {
  const activity = (p?.activity ?? {}) as Record<string, number>;
  return {
    uid,
    name: p?.name ?? "Lingora learner",
    handle: p?.handle ?? "",
    hue: p?.hue ?? hueFor(uid),
    langs: p?.langs ?? [],
    streak: streakOf(activity, today),
    weekMinutes: minutesSince(activity, weekStart),
    practisedToday: (activity[today] ?? 0) > 0,
  };
}

async function getProfiles(uids: string[]): Promise<Map<string, DocumentData>> {
  const out = new Map<string, DocumentData>();
  const unique = [...new Set(uids)];
  for (let i = 0; i < unique.length; i += 100) {
    const snaps = await db().getAll(...unique.slice(i, i + 100).map((u) => profiles().doc(u)));
    snaps.forEach((s) => s.exists && out.set(s.id, s.data()!));
  }
  return out;
}

async function friendUids(uid: string): Promise<string[]> {
  const snap = await friendships().where("users", "array-contains", uid).get();
  return snap.docs.filter((d) => d.get("status") === "accepted").map((d) => (d.get("users") as string[]).find((u) => u !== uid)!);
}

async function requireFriend(uid: string, other: string) {
  const f = await friendships().doc(pairId(uid, other)).get();
  if (!f.exists || f.get("status") !== "accepted") throw new HttpsError("permission-denied", "You're not friends yet.");
}

// ---------- Profile & username ----------

function slug(name: string): string {
  const base = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "");
  return (base || "learner").slice(0, 16);
}

async function claimHandle(uid: string, wanted: string): Promise<string> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const h = attempt === 0 ? wanted : `${wanted.slice(0, 16)}${Math.floor(Math.random() * 900 + 100)}`;
    const ok = await db().runTransaction(async (tx) => {
      const ref = handles().doc(h);
      const snap = await tx.get(ref);
      if (snap.exists && snap.get("uid") !== uid) return false;
      tx.set(ref, { uid });
      return true;
    });
    if (ok) return h;
  }
  throw new HttpsError("already-exists", "Couldn't find a free username.");
}

export async function syncProfile(uid: string, email: string | undefined, d: { name?: string; langs?: string[] }) {
  const ref = profiles().doc(uid);
  const snap = await ref.get();
  const name = clip(d.name, 60) || snap.get("name") || "Lingora learner";
  const update: DocumentData = {
    name,
    langs: (d.langs ?? []).map((l) => clip(l, 40)).slice(0, 12),
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (email) update.emailHash = createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
  if (!snap.exists) {
    update.handle = await claimHandle(uid, slug(name));
    update.hue = hueFor(uid);
    update.activity = {};
    update.createdAt = FieldValue.serverTimestamp();
  }
  await ref.set(update, { merge: true });
  const p = (await ref.get()).data()!;
  return { handle: p.handle as string, hue: p.hue as number };
}

export async function setHandle(uid: string, wanted: string) {
  const h = clip(wanted, 20).toLowerCase().replace(/^@/, "");
  if (!HANDLE.test(h)) throw new HttpsError("invalid-argument", "Use 3–20 letters, numbers, dots or underscores.");
  const ref = profiles().doc(uid);
  await db().runTransaction(async (tx) => {
    const taken = await tx.get(handles().doc(h));
    if (taken.exists && taken.get("uid") !== uid) throw new HttpsError("already-exists", "That username is taken.");
    const p = await tx.get(ref);
    const old = p.get("handle") as string | undefined;
    if (old && old !== h) tx.delete(handles().doc(old));
    tx.set(handles().doc(h), { uid });
    tx.set(ref, { handle: h }, { merge: true });
  });
  return { handle: h };
}

// ---------- Activity & feed ----------

const FEED_TYPES = new Set(["lesson", "roleplay", "vocab", "plan"]);
const MILESTONES = [3, 7, 14, 30, 50, 100, 200, 365];

/**
 * The app sends its own per-day minute totals (`days`, recent days only). The server keeps the larger
 * value per day, so retries and several devices never double-count.
 */
export async function reportActivity(uid: string, d: {
  day: string; days?: Record<string, number>; event?: { type: string; params?: Record<string, string> };
}) {
  const today = day(d.day);
  const incoming = Object.entries(d.days ?? {})
    .filter(([k]) => DAY.test(k) && k <= addDays(today, 1) && k >= addDays(today, -14))
    .map(([k, v]) => [k, Math.max(0, Math.min(1440, Math.round(Number(v) || 0)))] as const);
  const ref = profiles().doc(uid);
  let streak = 0;
  let milestone: number | null = null;
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const activity = { ...((snap.get("activity") ?? {}) as Record<string, number>) };
    for (const [k, v] of incoming) activity[k] = Math.max(activity[k] ?? 0, v);
    const cutoff = addDays(today, -90);
    for (const k of Object.keys(activity)) if (k < cutoff) delete activity[k];
    streak = streakOf(activity, today);
    const last = (snap.get("lastMilestone") as number | undefined) ?? 0;
    const hit = MILESTONES.filter((m) => streak >= m && m > last).pop();
    if (hit && streak === hit) milestone = hit;
    tx.set(ref, { activity, lastActiveDay: today, ...(milestone ? { lastMilestone: milestone } : {}) }, { merge: true });
  });

  const feed = ref.collection("feed");
  if (d.event && FEED_TYPES.has(d.event.type)) {
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(d.event.params ?? {}).slice(0, 6)) params[clip(k, 20)] = clip(v, 120);
    await feed.add({ type: d.event.type, params, cheers: [], createdAt: FieldValue.serverTimestamp() });
  }
  if (milestone) {
    await feed.add({ type: "streak", params: { days: String(milestone) }, cheers: [], createdAt: FieldValue.serverTimestamp() });
  }
  return { streak };
}

// ---------- Search & contacts ----------

export async function searchUsers(uid: string, query: string, today: string, weekStart: string) {
  const q = clip(query, 20).toLowerCase().replace(/^@/, "");
  if (q.length < 2) return { users: [] };
  const snap = await handles().where(FieldPath.documentId(), ">=", q).where(FieldPath.documentId(), "<=", q + "\uf8ff").limit(10).get();
  const uids = snap.docs.map((d) => d.get("uid") as string).filter((u) => u !== uid);
  const ps = await getProfiles(uids);
  return { users: await withRelations(uid, uids.filter((u) => ps.has(u)).map((u) => toDTO(u, ps.get(u), today, weekStart))) };
}

export async function matchContacts(uid: string, hashes: string[], today: string, weekStart: string) {
  const clean = [...new Set(hashes.filter((h) => /^[a-f0-9]{64}$/.test(h)))].slice(0, 600);
  const found: ProfileDTO[] = [];
  for (let i = 0; i < clean.length; i += 30) {
    const snap = await profiles().where("emailHash", "in", clean.slice(i, i + 30)).get();
    snap.docs.filter((d) => d.id !== uid).forEach((d) => found.push(toDTO(d.id, d.data(), today, weekStart)));
  }
  return { users: await withRelations(uid, found) };
}

async function withRelations(uid: string, users: ProfileDTO[]) {
  if (users.length === 0) return [];
  const snaps = await db().getAll(...users.map((u) => friendships().doc(pairId(uid, u.uid))));
  return users.map((u, i) => {
    const f = snaps[i];
    const relation = !f.exists ? "none" : f.get("status") === "accepted" ? "friend" : f.get("requestedBy") === uid ? "requested" : "incoming";
    return { ...u, relation };
  });
}

export async function profileByHandle(handle: string) {
  const h = await handles().doc(clip(handle, 20).toLowerCase().replace(/^@/, "")).get();
  if (!h.exists) return null;
  const p = await profiles().doc(h.get("uid")).get();
  return p.exists ? { uid: p.id, name: p.get("name") as string, handle: p.get("handle") as string } : null;
}

// ---------- Friend requests ----------

export async function sendFriendRequest(uid: string, d: { uid?: string; handle?: string }) {
  let other = clip(d.uid, 128);
  if (!other && d.handle) other = (await profileByHandle(d.handle))?.uid ?? "";
  if (!other || other === uid) throw new HttpsError("not-found", "No one with that username.");
  if (!(await profiles().doc(other).get()).exists) throw new HttpsError("not-found", "No one with that username.");
  const ref = friendships().doc(pairId(uid, other));
  return db().runTransaction(async (tx) => {
    const f = await tx.get(ref);
    if (f.exists && f.get("status") === "accepted") return { relation: "friend" };
    if (f.exists && f.get("requestedBy") === other) {
      tx.update(ref, { status: "accepted", acceptedAt: FieldValue.serverTimestamp() });
      return { relation: "friend" };
    }
    tx.set(ref, { users: [uid, other].sort(), status: "pending", requestedBy: uid, createdAt: FieldValue.serverTimestamp() });
    return { relation: "requested" };
  });
}

export async function respondFriendRequest(uid: string, other: string, accept: boolean) {
  const ref = friendships().doc(pairId(uid, other));
  const f = await ref.get();
  if (!f.exists || f.get("status") !== "pending" || f.get("requestedBy") === uid) throw new HttpsError("not-found", "Request not found.");
  if (accept) await ref.update({ status: "accepted", acceptedAt: FieldValue.serverTimestamp() });
  else await ref.delete();
  return { relation: accept ? "friend" : "none" };
}

export async function removeFriend(uid: string, other: string) {
  await friendships().doc(pairId(uid, other)).delete();
  return { relation: "none" };
}

// ---------- Overview (Friends tab) ----------

export async function overview(uid: string, today: string, weekStart: string) {
  const fsnap = await friendships().where("users", "array-contains", uid).get();
  const friendsIds: string[] = [], incomingIds: string[] = [], outgoingIds: string[] = [];
  for (const d of fsnap.docs) {
    const other = (d.get("users") as string[]).find((u) => u !== uid)!;
    if (d.get("status") === "accepted") friendsIds.push(other);
    else if (d.get("requestedBy") === uid) outgoingIds.push(other);
    else incomingIds.push(other);
  }
  const ps = await getProfiles([uid, ...friendsIds, ...incomingIds, ...outgoingIds]);
  const dto = (u: string) => toDTO(u, ps.get(u), today, weekStart);

  // Feed: latest items from me and my friends.
  const feedOwners = [uid, ...friendsIds].slice(0, 60);
  const feedSnaps = await Promise.all(feedOwners.map((u) => profiles().doc(u).collection("feed").orderBy("createdAt", "desc").limit(8).get()));
  const feed = feedSnaps.flatMap((s, i) => s.docs.map((d) => {
    const owner = feedOwners[i];
    const cheers = (d.get("cheers") ?? []) as string[];
    const at = d.get("createdAt") as Timestamp | undefined;
    return {
      id: d.id, uid: owner, name: ps.get(owner)?.name ?? "", hue: ps.get(owner)?.hue ?? hueFor(owner),
      type: d.get("type") as string, params: (d.get("params") ?? {}) as Record<string, string>,
      createdAt: at ? at.toMillis() : Date.now(), cheers: cheers.length, cheeredByMe: cheers.includes(uid),
      planId: (d.get("params") ?? {}).planId ?? null,
    };
  })).sort((a, b) => b.createdAt - a.createdAt).slice(0, 40);

  // Nudges sent to me in the last 3 days.
  const nsnap = await profiles().doc(uid).collection("nudges").orderBy("createdAt", "desc").limit(10).get();
  const nudges = nsnap.docs.filter((d) => !d.get("seen")).map((d) => ({ id: d.id, from: d.get("from") as string, name: d.get("name") as string }));

  return {
    me: dto(uid),
    friends: friendsIds.map(dto).sort((a, b) => b.weekMinutes - a.weekMinutes),
    incoming: incomingIds.map(dto),
    outgoing: outgoingIds.map(dto),
    feed,
    nudges,
    challenges: await listChallenges(uid, today),
  };
}

// ---------- Cheers & nudges ----------

export async function cheer(uid: string, owner: string, itemId: string) {
  if (owner !== uid) await requireFriend(uid, owner);
  const ref = profiles().doc(owner).collection("feed").doc(clip(itemId, 64));
  return db().runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists) throw new HttpsError("not-found", "That update is gone.");
    const cheers = (s.get("cheers") ?? []) as string[];
    const on = !cheers.includes(uid);
    tx.update(ref, { cheers: on ? FieldValue.arrayUnion(uid) : FieldValue.arrayRemove(uid) });
    return { cheered: on, cheers: cheers.length + (on ? 1 : -1) };
  });
}

export async function nudge(uid: string, other: string, today: string) {
  await requireFriend(uid, other);
  const me = await profiles().doc(uid).get();
  await profiles().doc(other).collection("nudges").doc(`${uid}_${day(today)}`)
    .set({ from: uid, name: me.get("name") ?? "", seen: false, createdAt: FieldValue.serverTimestamp() });
  return { nudged: true };
}

export async function markNudgesSeen(uid: string, ids: string[]) {
  const batch = db().batch();
  ids.slice(0, 20).forEach((id) => batch.set(profiles().doc(uid).collection("nudges").doc(clip(id, 160)), { seen: true }, { merge: true }));
  await batch.commit();
  return { ok: true };
}

// ---------- Challenges & shared plans ----------

type ChallengeType = "duel" | "sprint" | "plan";

export async function createChallenge(uid: string, d: {
  type: ChallengeType; friends: string[]; day: string; endDay?: string; goalMinutes?: number; lang?: string; plan?: string; title?: string;
}) {
  const type = d.type;
  if (!["duel", "sprint", "plan"].includes(type)) throw new HttpsError("invalid-argument", "Unknown challenge.");
  const invited = [...new Set((d.friends ?? []).map((f) => clip(f, 128)))].filter((f) => f && f !== uid).slice(0, type === "duel" ? 1 : 5);
  if (invited.length === 0) throw new HttpsError("invalid-argument", "Pick a friend.");
  for (const f of invited) await requireFriend(uid, f);
  const start = day(d.day);
  const doc: DocumentData = {
    type, creator: uid, members: [uid], invited, startDay: start, createdAt: FieldValue.serverTimestamp(),
    endDay: type === "duel" ? addDays(start, 6) : type === "sprint" ? day(d.endDay ?? addDays(start, 6)) : null,
    goalMinutes: type === "sprint" ? Math.max(10, Math.min(600, Number(d.goalMinutes) || 60)) : null,
    lang: clip(d.lang, 40) || null,
    title: clip(d.title, 120) || null,
  };
  if (type === "plan") {
    if (!d.plan || d.plan.length > 60_000) throw new HttpsError("invalid-argument", "Plan missing.");
    const planRef = await sharedPlans().add({ owner: uid, lang: doc.lang, plan: d.plan, createdAt: FieldValue.serverTimestamp() });
    doc.planId = planRef.id;
  }
  const ref = await challenges().add(doc);
  return { id: ref.id };
}

export async function respondChallenge(uid: string, id: string, accept: boolean) {
  const ref = challenges().doc(clip(id, 64));
  await db().runTransaction(async (tx) => {
    const c = await tx.get(ref);
    if (!c.exists || !((c.get("invited") as string[]) ?? []).includes(uid)) throw new HttpsError("not-found", "Invite not found.");
    tx.update(ref, {
      invited: FieldValue.arrayRemove(uid),
      ...(accept ? { members: FieldValue.arrayUnion(uid) } : {}),
    });
  });
  return { ok: true };
}

export async function leaveChallenge(uid: string, id: string) {
  await challenges().doc(clip(id, 64)).update({ members: FieldValue.arrayRemove(uid), invited: FieldValue.arrayRemove(uid) });
  return { ok: true };
}

async function listChallenges(uid: string, today: string) {
  const [a, b] = await Promise.all([
    challenges().where("members", "array-contains", uid).get(),
    challenges().where("invited", "array-contains", uid).get(),
  ]);
  const docs = new Map([...a.docs, ...b.docs].map((d) => [d.id, d]));
  const recent = [...docs.values()].filter((d) => !d.get("endDay") || (d.get("endDay") as string) >= addDays(today, -3));
  const people = await getProfiles(recent.flatMap((d) => [...(d.get("members") as string[]), ...(d.get("invited") as string[])]));
  return recent.map((d) => {
    const c = d.data();
    const members = c.members as string[];
    const rows = members.map((m) => {
      const act = (people.get(m)?.activity ?? {}) as Record<string, number>;
      const value = c.type === "duel" ? daysActiveSince(act, c.startDay, c.endDay) : c.type === "sprint" ? minutesSince(act, c.startDay, c.endDay) : 0;
      return { uid: m, name: people.get(m)?.name ?? "", hue: people.get(m)?.hue ?? hueFor(m), value };
    });
    return {
      id: d.id, type: c.type as ChallengeType, creator: c.creator as string,
      creatorName: people.get(c.creator)?.name ?? "",
      invitedMe: (c.invited as string[]).includes(uid),
      pending: (c.invited as string[]).map((u) => people.get(u)?.name ?? ""),
      startDay: c.startDay as string, endDay: (c.endDay as string) ?? null,
      goal: c.type === "duel" ? 7 : (c.goalMinutes as number) ?? 0,
      lang: (c.lang as string) ?? null, title: (c.title as string) ?? null, planId: (c.planId as string) ?? null,
      rows,
    };
  }).sort((x, y) => (y.startDay ?? "").localeCompare(x.startDay ?? ""));
}

export async function sharePlan(uid: string, d: { lang: string; title: string; plan: string }) {
  if (!d.plan || d.plan.length > 60_000) throw new HttpsError("invalid-argument", "Plan missing.");
  const planRef = await sharedPlans().add({ owner: uid, lang: clip(d.lang, 40), plan: d.plan, createdAt: FieldValue.serverTimestamp() });
  await profiles().doc(uid).collection("feed").add({
    type: "plan", params: { lang: clip(d.lang, 40), title: clip(d.title, 120), planId: planRef.id },
    cheers: [], createdAt: FieldValue.serverTimestamp(),
  });
  return { planId: planRef.id };
}

export async function getSharedPlan(uid: string, planId: string) {
  const s = await sharedPlans().doc(clip(planId, 64)).get();
  if (!s.exists) throw new HttpsError("not-found", "That plan is gone.");
  if (s.get("owner") !== uid) await requireFriend(uid, s.get("owner"));
  return { lang: s.get("lang") as string, plan: s.get("plan") as string };
}

// ---------- Friend chat ----------

export async function chatMessages(uid: string, other: string) {
  await requireFriend(uid, other);
  const snap = await db().collection("chats").doc(pairId(uid, other)).collection("messages").orderBy("createdAt", "desc").limit(60).get();
  return {
    messages: snap.docs.reverse().map((d) => {
      const at = d.get("createdAt") as Timestamp | undefined;
      const mine = d.get("from") === uid;
      return {
        id: d.id, mine, text: d.get("text") as string, createdAt: at ? at.toMillis() : Date.now(),
        correction: mine ? (d.get("correction") ?? null) : null,
      };
    }),
  };
}

export async function sendChatMessage(uid: string, other: string, text: string,
  correct: ((t: string) => Promise<{ wrong: string; right: string; note: string } | null>) | null) {
  await requireFriend(uid, other);
  const t = clip(text, 1000);
  if (!t) throw new HttpsError("invalid-argument", "Empty message.");
  let correction = null;
  if (correct) {
    try {
      correction = await correct(t);
    } catch {
      correction = null;
    }
  }
  const ref = await db().collection("chats").doc(pairId(uid, other)).collection("messages")
    .add({ from: uid, text: t, correction, createdAt: FieldValue.serverTimestamp() });
  return { id: ref.id, correction };
}

// ---------- Devices ----------

export async function registerDevice(uid: string, d: { id: string; name: string; model: string; os: string }) {
  const id = clip(d.id, 64) || randomUUID();
  await db().collection("users").doc(uid).collection("devices").doc(id).set({
    name: clip(d.name, 60), model: clip(d.model, 60), os: clip(d.os, 40), lastSeen: FieldValue.serverTimestamp(),
  }, { merge: true });
  return { id };
}

export async function listDevices(uid: string) {
  const snap = await db().collection("users").doc(uid).collection("devices").orderBy("lastSeen", "desc").limit(20).get();
  return {
    devices: snap.docs.map((d) => ({
      id: d.id, name: d.get("name") as string, model: d.get("model") as string, os: d.get("os") as string,
      lastSeen: (d.get("lastSeen") as Timestamp | undefined)?.toMillis() ?? 0,
    })),
  };
}

export async function removeDevice(uid: string, id: string) {
  await db().collection("users").doc(uid).collection("devices").doc(clip(id, 64)).delete();
  return { ok: true };
}

export { friendUids };
