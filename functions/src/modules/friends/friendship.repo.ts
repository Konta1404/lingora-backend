/** friendships/{uidA_uidB}: {users, status: "pending" | "accepted", requestedBy}. */
import { AppError } from "../../core/errors";
import { col } from "../../infra/collections";
import { db } from "../../infra/firebase";

export type Relation = "none" | "friend" | "requested" | "incoming";

/** One id per pair, whatever the order. */
export const pairId = (a: string, b: string) => [a, b].sort().join("_");

export const friendshipRef = (a: string, b: string) => col.friendships().doc(pairId(a, b));

export async function requireFriend(uid: string, other: string): Promise<void> {
  const f = await friendshipRef(uid, other).get();
  if (!f.exists || f.get("status") !== "accepted") throw new AppError("permission-denied", "You're not friends yet.");
}

/** All friendship docs that involve this person (accepted and pending). */
export const friendshipsOf = (uid: string) => col.friendships().where("users", "array-contains", uid).get();

export async function countFriends(uid: string): Promise<number> {
  return (await friendshipsOf(uid)).docs.filter((d) => d.get("status") === "accepted").length;
}

/** How `uid` relates to each of `others`, in order. */
export async function relationsTo(uid: string, others: string[]): Promise<Relation[]> {
  if (others.length === 0) return [];
  const snaps = await db().getAll(...others.map((o) => friendshipRef(uid, o)));
  return snaps.map((f) =>
    !f.exists ? "none" : f.get("status") === "accepted" ? "friend" : f.get("requestedBy") === uid ? "requested" : "incoming",
  );
}

/** Adds `relation` to each person. */
export async function withRelations<T extends { uid: string }>(uid: string, users: T[]): Promise<(T & { relation: Relation })[]> {
  const rel = await relationsTo(uid, users.map((u) => u.uid));
  return users.map((u, i) => ({ ...u, relation: rel[i] }));
}
