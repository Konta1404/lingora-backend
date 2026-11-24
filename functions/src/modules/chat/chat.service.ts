/**
 * Friend chat: chats/{pairId} holds the last message and unread counts, chats/{pairId}/messages the history.
 * The sender can get an optional AI correction of their own message; only they ever see it.
 */
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { AppError } from "../../core/errors";
import { clip } from "../../core/text";
import { col } from "../../infra/collections";
import { db } from "../../infra/firebase";
import { pairId, requireFriend } from "../friends/friendship.repo";
import { Correction } from "../ai/correction";

const HISTORY = 60;
const MAX_TEXT = 1000;
const PREVIEW = 140;

export type Corrector = (text: string) => Promise<Correction | null>;

const chatRef = (a: string, b: string) => col.chats().doc(pairId(a, b));

export async function chatMessages(uid: string, other: string) {
  await requireFriend(uid, other);
  const chat = chatRef(uid, other);
  if (((await chat.get()).get(`unread.${uid}`) ?? 0) > 0) await chat.set({ unread: { [uid]: 0 } }, { merge: true });
  const snap = await chat.collection("messages").orderBy("createdAt", "desc").limit(HISTORY).get();
  return {
    messages: snap.docs.reverse().map((d) => {
      const at = d.get("createdAt") as Timestamp | undefined;
      const mine = d.get("from") === uid;
      return {
        id: d.id,
        mine,
        text: d.get("text") as string,
        createdAt: at ? at.toMillis() : Date.now(),
        correction: mine ? (d.get("correction") ?? null) : null,
      };
    }),
  };
}

export async function sendChatMessage(uid: string, other: string, text: string, correct: Corrector | null) {
  await requireFriend(uid, other);
  const t = clip(text, MAX_TEXT);
  if (!t) throw new AppError("invalid-argument", "Empty message.");
  const correction = correct ? await correct(t).catch(() => null) : null;
  const chat = chatRef(uid, other);
  const ref = await chat.collection("messages").add({ from: uid, text: t, correction, createdAt: FieldValue.serverTimestamp() });
  await chat.set({
    users: [uid, other].sort(),
    lastText: t.slice(0, PREVIEW),
    lastFrom: uid,
    lastAt: FieldValue.serverTimestamp(),
    unread: { [other]: FieldValue.increment(1), [uid]: 0 },
  }, { merge: true });
  return { id: ref.id, correction };
}

/** Last message and unread count for each friend, in order. */
export async function chatSummaries(uid: string, friends: string[]) {
  if (friends.length === 0) return [];
  const snaps = await db().getAll(...friends.map((f) => chatRef(uid, f)));
  return snaps.map((c) => {
    const at = c.get("lastAt") as Timestamp | undefined;
    return {
      unread: (c.exists ? (c.get(`unread.${uid}`) as number | undefined) : 0) ?? 0,
      lastMessage: c.exists ? ((c.get("lastText") as string | undefined) ?? null) : null,
      lastMessageAt: at ? at.toMillis() : null,
      lastFromMe: c.exists ? c.get("lastFrom") === uid : false,
    };
  });
}
