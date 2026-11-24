import { col } from "../../infra/collections";
import { db } from "../../infra/firebase";
import { ProfileDoc } from "./profile.model";

const BATCH = 100;

export const profileRef = (uid: string) => col.profiles().doc(uid);

export async function getProfile(uid: string): Promise<ProfileDoc | undefined> {
  return (await profileRef(uid).get()).data() as ProfileDoc | undefined;
}

/** Many profiles at once (missing ones are left out). */
export async function getProfiles(uids: string[]): Promise<Map<string, ProfileDoc>> {
  const out = new Map<string, ProfileDoc>();
  const unique = [...new Set(uids)];
  for (let i = 0; i < unique.length; i += BATCH) {
    const snaps = await db().getAll(...unique.slice(i, i + BATCH).map(profileRef));
    snaps.forEach((s) => s.exists && out.set(s.id, s.data() as ProfileDoc));
  }
  return out;
}

/** uid behind a username, if any. */
export async function uidForHandle(handle: string): Promise<string | null> {
  if (!handle) return null;
  const h = await col.handles().doc(handle).get();
  return h.exists ? (h.get("uid") as string) : null;
}
