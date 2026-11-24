/** Callables for the social features. Each one only coerces input and delegates to a service. */
import { userCallable } from "../api/define";
import { strings } from "../core/text";
import { correctMessageText } from "./ai/correction";
import { bestEffortPlan } from "./ai/plan";
import { Lang } from "./ai/prompts";
import { reportActivity as report, ActivityInput } from "./activity/activity.service";
import * as challenges from "./challenges/challenges.service";
import * as plans from "./challenges/plans.service";
import * as chat from "./chat/chat.service";
import * as devices from "./devices/devices.service";
import { sendFeedback as feedback } from "./feedback/feedback.service";
import * as friends from "./friends/friends.service";
import * as interactions from "./friends/interactions.service";
import { overview } from "./friends/overview.service";
import { leagueStatus as league } from "./leagues/league.service";
import { setAvatar as avatar } from "./profiles/avatar.service";
import { setHandle as handle } from "./profiles/handles";
import * as profiles from "./profiles/profile.service";

type Days = { day: string; weekStart: string };
const s = (v: unknown) => String(v ?? "");

// ---------- Profile ----------

export const profileSync = userCallable<{ name?: string; langs?: string[] }>((d, u) => profiles.syncProfile(u.uid, u.email, d));
export const setHandle = userCallable<{ handle?: string }>((d, u) => handle(u.uid, s(d.handle)));
export const setPrivacy = userCallable<{ shareActivity?: boolean }>((d, u) => profiles.setPrivacy(u.uid, d.shareActivity !== false));
export const setAvatar = userCallable<{ image?: string | null }>((d, u) => avatar(u.uid, d.image ?? null));
export const publicProfile = userCallable<{ uid?: string; handle?: string } & Days>((d, u) => profiles.publicProfile(u.uid, d));
export const reportActivity = userCallable<ActivityInput>((d, u) => report(u.uid, d));
export const leagueStatus = userCallable<Days>((d, u) => league(u.uid, d.weekStart, d.day));
export const sendFeedback = userCallable<{ text?: string; app?: string; device?: string; uiLanguage?: string }>((d, u) =>
  feedback(u.uid, u.email, d));

// ---------- Friends ----------

export const searchUsers = userCallable<Days & { query?: string }>((d, u) => friends.searchUsers(u.uid, s(d.query), d.day, d.weekStart));
export const matchContacts = userCallable<Days & { hashes?: unknown }>((d, u) =>
  friends.matchContacts(u.uid, strings(d.hashes), d.day, d.weekStart));
export const sendFriendRequest = userCallable<{ uid?: string; handle?: string }>((d, u) => friends.sendFriendRequest(u.uid, d));
export const respondFriendRequest = userCallable<{ uid?: string; accept?: boolean }>((d, u) =>
  friends.respondFriendRequest(u.uid, s(d.uid), !!d.accept));
export const removeFriend = userCallable<{ uid?: string }>((d, u) => friends.removeFriend(u.uid, s(d.uid)));
export const friendsOverview = userCallable<Days>((d, u) => overview(u.uid, d.day, d.weekStart));
export const cheer = userCallable<{ owner?: string; id?: string }>((d, u) => interactions.cheer(u.uid, s(d.owner), s(d.id)));
export const nudge = userCallable<{ uid?: string; day?: string }>((d, u) => interactions.nudge(u.uid, s(d.uid), d.day));
export const markNudgesSeen = userCallable<{ ids?: unknown }>((d, u) => interactions.markNudgesSeen(u.uid, strings(d.ids)));

// ---------- Challenges & shared plans ----------

export const createChallenge = userCallable<challenges.ChallengeInput>((d, u) => challenges.createChallenge(u.uid, d));
export const respondChallenge = userCallable<{ id?: string; accept?: boolean }>((d, u) =>
  challenges.respondChallenge(u.uid, s(d.id), !!d.accept));
export const leaveChallenge = userCallable<{ id?: string }>((d, u) => challenges.leaveChallenge(u.uid, s(d.id)));
export const sharePlan = userCallable<{ lang: string; title: string; plan: string }>((d, u) => plans.sharePlan(u.uid, d));
export const getSharedPlan = userCallable<{ planId?: string }>((d, u) => plans.getSharedPlan(u.uid, s(d.planId)));

// ---------- Chat ----------

export const chatMessages = userCallable<{ uid?: string }>((d, u) => chat.chatMessages(u.uid, s(d.uid)));

/** With a connected ChatGPT plan, the sender also gets a quiet correction of their message. */
export const sendChatMessage = userCallable<{ uid?: string; text?: string; language?: Lang; uiLanguage?: string }>(async (d, u) => {
  const ai = d.language?.name ? await bestEffortPlan(u.uid) : null;
  const correct: chat.Corrector | null = ai
    ? async (text) => {
        const r = await correctMessageText(ai, d.language, text, d, { strictLanguage: true });
        return r.hasCorrection && r.wrong && r.right ? { wrong: r.wrong, right: r.right, note: r.note } : null;
      }
    : null;
  return chat.sendChatMessage(u.uid, s(d.uid), s(d.text), correct);
});

// ---------- Devices ----------

export const registerDevice = userCallable<{ id?: string; name?: string; model?: string; os?: string }>((d, u) =>
  devices.registerDevice(u.uid, d));
export const listDevices = userCallable((_d, u) => devices.listDevices(u.uid));
export const removeDevice = userCallable<{ id?: string }>((d, u) => devices.removeDevice(u.uid, s(d.id)));
