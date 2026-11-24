/** Everything the Friends tab shows, in one call. */
import { Timestamp } from "firebase-admin/firestore";
import { Day } from "../../core/dates";
import { feedOf, nudgesOf } from "../../infra/collections";
import { pairStreak } from "../activity/streaks";
import { listChallenges } from "../challenges/challenges.service";
import { chatSummaries } from "../chat/chat.service";
import { hueFor, photoOf, sharesActivity, toDTO } from "../profiles/profile.model";
import { getProfiles } from "../profiles/profile.repo";
import { friendshipsOf } from "./friendship.repo";

const FEED_OWNERS = 60;
const FEED_PER_OWNER = 8;
const FEED_SIZE = 40;
const NUDGES = 10;

export async function overview(uid: string, today: Day, weekStart: Day) {
  const friendIds: string[] = [], incomingIds: string[] = [], outgoingIds: string[] = [];
  for (const d of (await friendshipsOf(uid)).docs) {
    const other = (d.get("users") as string[]).find((u) => u !== uid)!;
    if (d.get("status") === "accepted") friendIds.push(other);
    else if (d.get("requestedBy") === uid) outgoingIds.push(other);
    else incomingIds.push(other);
  }
  const ps = await getProfiles([uid, ...friendIds, ...incomingIds, ...outgoingIds]);
  const dto = (u: string) => toDTO(u, ps.get(u), today, weekStart, uid);

  // Feed: latest items from me and my friends. Private people only show their shared plans.
  const owners = [uid, ...friendIds].slice(0, FEED_OWNERS);
  const feedSnaps = await Promise.all(owners.map((u) => feedOf(u).orderBy("createdAt", "desc").limit(FEED_PER_OWNER).get()));
  const feed = feedSnaps.flatMap((s, i) => {
    const owner = owners[i];
    const p = ps.get(owner);
    return s.docs
      .filter((d) => owner === uid || sharesActivity(p) || d.get("type") === "plan")
      .map((d) => {
        const cheers = (d.get("cheers") ?? []) as string[];
        const at = d.get("createdAt") as Timestamp | undefined;
        const params = (d.get("params") ?? {}) as Record<string, string>;
        return {
          id: d.id, uid: owner, name: p?.name ?? "", hue: p?.hue ?? hueFor(owner), photo: photoOf(p),
          type: d.get("type") as string, params,
          createdAt: at ? at.toMillis() : Date.now(), cheers: cheers.length, cheeredByMe: cheers.includes(uid),
          planId: params.planId ?? null,
        };
      });
  }).sort((a, b) => b.createdAt - a.createdAt).slice(0, FEED_SIZE);

  const nudgeSnap = await nudgesOf(uid).orderBy("createdAt", "desc").limit(NUDGES).get();
  const nudges = nudgeSnap.docs.filter((d) => !d.get("seen")).map((d) => ({ id: d.id, from: d.get("from") as string, name: d.get("name") as string }));

  const chats = await chatSummaries(uid, friendIds);
  const friends = friendIds.map((f, i) => ({
    ...dto(f),
    friendStreak: sharesActivity(ps.get(f)) ? pairStreak(ps.get(uid)?.activity ?? {}, ps.get(f)?.activity ?? {}, today) : 0,
    ...chats[i],
  }));

  return {
    me: dto(uid),
    friends: friends.sort((a, b) => b.weekMinutes - a.weekMinutes),
    incoming: incomingIds.map(dto),
    outgoing: outgoingIds.map(dto),
    feed,
    nudges,
    challenges: await listChallenges(uid, today),
  };
}
