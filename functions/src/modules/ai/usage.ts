import { FieldValue } from "firebase-admin/firestore";
import { loadConfig } from "../../config/env";
import { AppError } from "../../core/errors";
import { todayUTC } from "../../core/dates";
import { col } from "../../infra/collections";
import { db } from "../../infra/firebase";

/** Counts one AI call against the user's daily cap (usage/{uid}_{day}). Throws once the cap is passed. */
export async function countUsage(uid: string): Promise<void> {
  const day = todayUTC();
  const ref = col.usage().doc(`${uid}_${day}`);
  const count = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const n = ((snap.get("count") as number) ?? 0) + 1;
    tx.set(ref, { count: n, uid, day, at: FieldValue.serverTimestamp() }, { merge: true });
    return n;
  });
  if (count > loadConfig().dailyAiLimit) {
    throw new AppError("resource-exhausted", "Daily ChatGPT limit reached. It resets tomorrow.");
  }
}
