/** Usernames: handles/{handle} → {uid}, kept unique with transactions. */
import { AppError } from "../../core/errors";
import { col } from "../../infra/collections";
import { db } from "../../infra/firebase";
import { HANDLE, normalizeHandle } from "./profile.model";
import { profileRef } from "./profile.repo";

const CLAIM_ATTEMPTS = 6;

/** Claims `wanted`, or `wanted` plus three digits if it's taken. */
export async function claimHandle(uid: string, wanted: string): Promise<string> {
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
    const h = attempt === 0 ? wanted : `${wanted.slice(0, 16)}${Math.floor(Math.random() * 900 + 100)}`;
    const ok = await db().runTransaction(async (tx) => {
      const ref = col.handles().doc(h);
      const snap = await tx.get(ref);
      if (snap.exists && snap.get("uid") !== uid) return false;
      tx.set(ref, { uid });
      return true;
    });
    if (ok) return h;
  }
  throw new AppError("already-exists", "Couldn't find a free username.");
}

export async function setHandle(uid: string, wanted: unknown) {
  const h = normalizeHandle(wanted);
  if (!HANDLE.test(h)) throw new AppError("invalid-argument", "Use 3–20 letters, numbers, dots or underscores.");
  const ref = profileRef(uid);
  await db().runTransaction(async (tx) => {
    const taken = await tx.get(col.handles().doc(h));
    if (taken.exists && taken.get("uid") !== uid) throw new AppError("already-exists", "That username is taken.");
    const p = await tx.get(ref);
    const old = p.get("handle") as string | undefined;
    if (old && old !== h) tx.delete(col.handles().doc(old));
    tx.set(col.handles().doc(h), { uid });
    tx.set(ref, { handle: h }, { merge: true });
  });
  return { handle: h };
}
