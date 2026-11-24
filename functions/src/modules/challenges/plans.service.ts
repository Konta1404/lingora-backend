/** Study plans shared with friends (sharedPlans/{id}); the app's plan JSON is stored as-is. */
import { FieldValue } from "firebase-admin/firestore";
import { AppError } from "../../core/errors";
import { clip } from "../../core/text";
import { col, feedOf } from "../../infra/collections";
import { requireFriend } from "../friends/friendship.repo";

export const MAX_PLAN_CHARS = 60_000;

export async function sharePlan(uid: string, d: { lang: string; title: string; plan: string }) {
  if (!d.plan || typeof d.plan !== "string" || d.plan.length > MAX_PLAN_CHARS) throw new AppError("invalid-argument", "Plan missing.");
  const planRef = await col.sharedPlans().add({ owner: uid, lang: clip(d.lang, 40), plan: d.plan, createdAt: FieldValue.serverTimestamp() });
  await feedOf(uid).add({
    type: "plan",
    params: { lang: clip(d.lang, 40), title: clip(d.title, 120), planId: planRef.id },
    cheers: [],
    createdAt: FieldValue.serverTimestamp(),
  });
  return { planId: planRef.id };
}

export async function getSharedPlan(uid: string, planId: string) {
  const s = await col.sharedPlans().doc(clip(planId, 64) || "-").get();
  if (!s.exists) throw new AppError("not-found", "That plan is gone.");
  if (s.get("owner") !== uid) await requireFriend(uid, s.get("owner"));
  return { lang: s.get("lang") as string, plan: s.get("plan") as string };
}
