/** Profile photos: a small JPEG/PNG (~256×256) stored in avatars/{uid}. No Cloud Storage bucket needed. */
import { AppError } from "../../core/errors";
import { clip } from "../../core/text";
import { col } from "../../infra/collections";
import { profileRef } from "./profile.repo";

/** The decoded image must fit the 256 KB request limit as base64. */
export const MAX_PHOTO_BYTES = 180_000;

/** Decodes and checks an uploaded photo. */
export function parsePhoto(base64: string): { data: Buffer; type: "image/jpeg" | "image/png" } {
  const data = Buffer.from(String(base64), "base64");
  if (data.length < 100 || data.length > MAX_PHOTO_BYTES) throw new AppError("invalid-argument", "That photo is too large.");
  if (data[0] === 0xff && data[1] === 0xd8) return { data, type: "image/jpeg" };
  if (data[0] === 0x89 && data[1] === 0x50) return { data, type: "image/png" };
  throw new AppError("invalid-argument", "Use a JPEG or PNG photo.");
}

export async function setAvatar(uid: string, base64: string | null) {
  if (!base64) {
    await col.avatars().doc(uid).delete();
    await profileRef(uid).set({ photoVersion: 0 }, { merge: true });
    return { photo: 0 };
  }
  const photo = parsePhoto(base64);
  const version = Date.now();
  await col.avatars().doc(uid).set({ ...photo, version });
  await profileRef(uid).set({ photoVersion: version }, { merge: true });
  return { photo: version };
}

export async function getAvatar(uid: string): Promise<{ data: Buffer; type: string } | null> {
  const id = clip(uid, 128);
  if (!id) return null;
  const s = await col.avatars().doc(id).get();
  if (!s.exists) return null;
  return { data: Buffer.from(s.get("data")), type: s.get("type") as string };
}
