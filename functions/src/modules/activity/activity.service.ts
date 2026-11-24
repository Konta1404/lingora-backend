import { FieldValue } from "firebase-admin/firestore";
import { parseDay } from "../../core/dates";
import { clip } from "../../core/text";
import { feedOf } from "../../infra/collections";
import { db } from "../../infra/firebase";
import { ProfileDoc, cleanStats, sharesActivity } from "../profiles/profile.model";
import { profileRef } from "../profiles/profile.repo";
import { mergeReport, ActivityReport } from "./streaks";

/** Feed items the app may post. Streak milestones are added by the server. */
const FEED_TYPES = new Set(["lesson", "roleplay", "vocab", "plan"]);

export interface ActivityInput extends ActivityReport {
  day: unknown;
  stats?: Record<string, unknown>;
  event?: { type: string; params?: Record<string, unknown> };
}

export async function reportActivity(uid: string, d: ActivityInput) {
  const today = parseDay(d.day);
  const ref = profileRef(uid);
  let streak = 0;
  let milestone: number | null = null;
  let shares = true;

  await db().runTransaction(async (tx) => {
    const p = ((await tx.get(ref)).data() ?? {}) as ProfileDoc;
    shares = sharesActivity(p);
    const merged = mergeReport(
      { activity: p.activity ?? {}, xpDays: p.xpDays ?? {}, frozen: p.frozen ?? [], lastMilestone: p.lastMilestone ?? 0 },
      d,
      today,
    );
    streak = merged.streak;
    milestone = merged.milestone;
    tx.set(ref, {
      activity: merged.activity,
      xpDays: merged.xpDays,
      frozen: merged.frozen,
      lastActiveDay: today,
      ...(d.stats ? { stats: cleanStats(d.stats) } : {}),
      ...(milestone ? { lastMilestone: milestone } : {}),
    }, { merge: true });
  });

  if (!shares) return { streak };
  const feed = feedOf(uid);
  if (d.event && FEED_TYPES.has(d.event.type)) {
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(d.event.params ?? {}).slice(0, 6)) params[clip(k, 20)] = clip(v, 120);
    await feed.add({ type: d.event.type, params, cheers: [], createdAt: FieldValue.serverTimestamp() });
  }
  if (milestone) {
    await feed.add({ type: "streak", params: { days: String(milestone) }, cheers: [], createdAt: FieldValue.serverTimestamp() });
  }
  return { streak };
}
