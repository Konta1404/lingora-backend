import { FieldValue } from "firebase-admin/firestore";
import { AppError } from "../../core/errors";
import { truncate } from "../../core/text";
import { col } from "../../infra/collections";

/** "Send feedback" from Settings, stored in feedback/ for the team to read. */
export async function sendFeedback(uid: string, email: string | undefined, d: { text?: unknown; app?: unknown; device?: unknown; uiLanguage?: unknown }) {
  const text = truncate(d.text, 4000);
  if (!text) throw new AppError("invalid-argument", "Empty message.");
  await col.feedback().add({
    uid,
    email: email ?? null,
    text,
    app: truncate(d.app, 40),
    device: truncate(d.device, 80),
    uiLanguage: truncate(d.uiLanguage, 20),
    createdAt: FieldValue.serverTimestamp(),
  });
  return { ok: true };
}
