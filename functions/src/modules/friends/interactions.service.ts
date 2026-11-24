/** Cheers on feed items and nudges between friends. */
import { FieldValue } from "firebase-admin/firestore";
import { AppError } from "../../core/errors";
import { parseDay } from "../../core/dates";
import { clip } from "../../core/text";
import { feedOf, nudgesOf } from "../../infra/collections";
import { db } from "../../infra/firebase";
import { profileRef } from "../profiles/profile.repo";
import { requireFriend } from "./friendship.repo";

/** Toggles the caller's cheer on a feed item. */
export async function cheer(uid: string, owner: string, itemId: string) {
  if (owner !== uid) await requireFriend(uid, owner);
  const ref = feedOf(owner).doc(clip(itemId, 64) || "-");
  return db().runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists) throw new AppError("not-found", "That update is gone.");
    const cheers = (s.get("cheers") ?? []) as string[];
    const on = !cheers.includes(uid);
    tx.update(ref, { cheers: on ? FieldValue.arrayUnion(uid) : FieldValue.arrayRemove(uid) });
    return { cheered: on, cheers: cheers.length + (on ? 1 : -1) };
  });
}

/** One nudge per sender per day (the doc id makes repeats idempotent). */
export async function nudge(uid: string, other: string, today: unknown) {
  await requireFriend(uid, other);
  const me = await profileRef(uid).get();
  await nudgesOf(other).doc(`${uid}_${parseDay(today)}`)
    .set({ from: uid, name: me.get("name") ?? "", seen: false, createdAt: FieldValue.serverTimestamp() });
  return { nudged: true };
}

export async function markNudgesSeen(uid: string, ids: string[]) {
  const batch = db().batch();
  ids.slice(0, 20).map((id) => clip(id, 160)).filter(Boolean)
    .forEach((id) => batch.set(nudgesOf(uid).doc(id), { seen: true }, { merge: true }));
  await batch.commit();
  return { ok: true };
}
