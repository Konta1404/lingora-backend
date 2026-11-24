/** Finding people and friend requests. */
import { FieldPath, FieldValue } from "firebase-admin/firestore";
import { AppError } from "../../core/errors";
import { Day } from "../../core/dates";
import { clip } from "../../core/text";
import { col } from "../../infra/collections";
import { db } from "../../infra/firebase";
import { ProfileDTO, ProfileDoc, normalizeHandle, toDTO } from "../profiles/profile.model";
import { getProfiles, profileRef } from "../profiles/profile.repo";
import { resolveUser } from "../profiles/profile.service";
import { friendshipRef, withRelations } from "./friendship.repo";

const SEARCH_LIMIT = 10;
const MAX_CONTACT_HASHES = 600;
/** Firestore "in" queries take at most 30 values. */
const IN_LIMIT = 30;

/** Username prefix search. */
export async function searchUsers(uid: string, query: unknown, today: Day, weekStart: Day) {
  const q = normalizeHandle(query);
  if (q.length < 2) return { users: [] };
  const snap = await col.handles()
    .where(FieldPath.documentId(), ">=", q)
    .where(FieldPath.documentId(), "<=", q + "")
    .limit(SEARCH_LIMIT)
    .get();
  const uids = snap.docs.map((d) => d.get("uid") as string).filter((u) => u !== uid);
  const ps = await getProfiles(uids);
  const users = uids.filter((u) => ps.has(u)).map((u) => toDTO(u, ps.get(u), today, weekStart, uid));
  return { users: await withRelations(uid, users) };
}

/** People in the caller's contacts, matched by SHA-256 of their email (the app hashes on device). */
export async function matchContacts(uid: string, hashes: string[], today: Day, weekStart: Day) {
  const clean = [...new Set(hashes.filter((h) => /^[a-f0-9]{64}$/.test(h)))].slice(0, MAX_CONTACT_HASHES);
  const found: ProfileDTO[] = [];
  for (let i = 0; i < clean.length; i += IN_LIMIT) {
    const snap = await col.profiles().where("emailHash", "in", clean.slice(i, i + IN_LIMIT)).get();
    snap.docs.filter((d) => d.id !== uid).forEach((d) => found.push(toDTO(d.id, d.data() as ProfileDoc, today, weekStart, uid)));
  }
  return { users: await withRelations(uid, found) };
}

/** Sends a request, or accepts theirs if they already asked. */
export async function sendFriendRequest(uid: string, d: { uid?: unknown; handle?: unknown }) {
  const other = await resolveUser(d);
  if (!other || other === uid) throw new AppError("not-found", "No one with that username.");
  if (!(await profileRef(other).get()).exists) throw new AppError("not-found", "No one with that username.");
  const ref = friendshipRef(uid, other);
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
  const ref = friendshipRef(uid, clip(other, 128));
  const f = await ref.get();
  if (!f.exists || f.get("status") !== "pending" || f.get("requestedBy") === uid) throw new AppError("not-found", "Request not found.");
  if (accept) await ref.update({ status: "accepted", acceptedAt: FieldValue.serverTimestamp() });
  else await ref.delete();
  return { relation: accept ? "friend" : "none" };
}

export async function removeFriend(uid: string, other: string) {
  await friendshipRef(uid, clip(other, 128)).delete();
  return { relation: "none" };
}
