/** The signed-in devices list in Settings: users/{uid}/devices/{id}. */
import { randomUUID } from "crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { clip } from "../../core/text";
import { devicesOf } from "../../infra/collections";

export async function registerDevice(uid: string, d: { id?: unknown; name?: unknown; model?: unknown; os?: unknown }) {
  const id = clip(d.id, 64) || randomUUID();
  await devicesOf(uid).doc(id).set({
    name: clip(d.name, 60), model: clip(d.model, 60), os: clip(d.os, 40), lastSeen: FieldValue.serverTimestamp(),
  }, { merge: true });
  return { id };
}

export async function listDevices(uid: string) {
  const snap = await devicesOf(uid).orderBy("lastSeen", "desc").limit(20).get();
  return {
    devices: snap.docs.map((d) => ({
      id: d.id,
      name: d.get("name") as string,
      model: d.get("model") as string,
      os: d.get("os") as string,
      lastSeen: (d.get("lastSeen") as Timestamp | undefined)?.toMillis() ?? 0,
    })),
  };
}

export async function removeDevice(uid: string, id: string) {
  const docId = clip(id, 64);
  if (docId) await devicesOf(uid).doc(docId).delete();
  return { ok: true };
}
