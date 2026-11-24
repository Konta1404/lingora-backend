/**
 * End to end through HTTP: the real callables and services on an in-memory Firestore,
 * driven the way the iOS app drives them.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Firestore } from "firebase-admin/firestore";
import { callables } from "../src/api/registry";
import { addDays } from "../src/core/dates";
import { useFirestore } from "../src/infra/firebase";
import { getAvatar } from "../src/modules/profiles/avatar.service";
import { webProfile } from "../src/modules/profiles/profile.service";
import { serve } from "./helpers";
import { FakeFirestore } from "./support/fake-firestore";

const TODAY = "2026-11-24";
const WEEK = "2026-11-23";
const days = { day: TODAY, weekStart: WEEK };
const int64 = (n: number) => ({ "@type": "type.googleapis.com/google.protobuf.Int64Value", value: String(n) });

const fake = new FakeFirestore();
let srv: Awaited<ReturnType<typeof serve>>;

/** Calls a callable as `uid` ("anon" = no token) and returns the parsed body, failing on HTTP errors unless asked. */
async function call(uid: string, name: string, data: unknown = {}) {
  const r = await srv.call(name, data, uid === "anon" ? undefined : `token:${uid}`);
  const body = await r.json();
  if (r.status !== 200) throw Object.assign(new Error(`${name} → ${r.status} ${JSON.stringify(body)}`), { status: r.status, body });
  return body.result;
}
async function fails(uid: string, name: string, data: unknown = {}) {
  const r = await srv.call(name, data, uid === "anon" ? undefined : `token:${uid}`);
  assert.notEqual(r.status, 200, `${name} should fail`);
  return { status: r.status, error: (await r.json()).error };
}

before(async () => {
  process.env.CHATGPT_CLIENT_ID = "not-set";
  useFirestore(fake as unknown as Firestore);
  srv = await serve({
    callables,
    verifyIdToken: async (t) => {
      if (!t.startsWith("token:")) throw new Error("bad");
      const uid = t.slice(6);
      return { uid, email: `${uid}@example.com` };
    },
    getAvatar,
    webProfile: (h) => webProfile(h, TODAY),
    chatgptCallback: async () => "lingora://chatgpt?status=error",
  });
});
after(async () => {
  await srv.close();
  useFirestore(null);
});

test("profiles: first sync creates a username, later syncs keep it", async () => {
  const a = await call("ana", "profileSync", { name: "Ana López", langs: ["es", "de"] });
  assert.equal(a.handle, "ana.lopez");
  assert.ok(a.hue >= 0 && a.hue < 360);
  const b = await call("ben", "profileSync", { name: "Ana López", langs: ["en"] });
  assert.match(b.handle, /^ana\.lopez\d{3}$/, "a taken username gets digits");
  assert.equal((await call("ana", "profileSync", { name: "Ana L" })).handle, "ana.lopez");
  assert.equal((await call("ben", "setHandle", { handle: "@Ben_K" })).handle, "ben_k");
  assert.equal(fake.docs.has(`handles/${b.handle}`), false, "old username is released");
  assert.equal((await fails("ana", "setHandle", { handle: "ben_k" })).error.status, "ALREADY_EXISTS");
  assert.equal((await fails("ana", "setHandle", { handle: "x" })).error.status, "INVALID_ARGUMENT");
});

test("anonymous callers are rejected", async () => {
  const { status, error } = await fails("anon", "profileSync", { name: "x" });
  assert.equal(status, 401);
  assert.equal(error.status, "UNAUTHENTICATED");
});

test("activity: the app's Int64 numbers are stored and streaks computed", async () => {
  const r = await call("ana", "reportActivity", {
    day: TODAY,
    days: { [TODAY]: int64(14), [addDays(TODAY, -1)]: int64(20), [addDays(TODAY, -2)]: 5 },
    xpDays: { [TODAY]: int64(112), [addDays(TODAY, -1)]: 30 },
    stats: { totalXP: int64(112), bestStreak: 3, lessons: 4, words: 50, stories: 1, achievements: { first: 1 } },
    event: { type: "lesson", params: { title: "Ser vs. estar" } },
  });
  assert.equal(r.streak, 3);
  const doc = fake.docs.get("profiles/ana")!;
  assert.equal((doc.activity as Record<string, number>)[TODAY], 14);
  assert.equal((doc.stats as { totalXP: number }).totalXP, 112);
  assert.equal(doc.lastMilestone, 3, "3-day milestone reached");
  const feed = [...fake.docs.keys()].filter((k) => k.startsWith("profiles/ana/feed/"));
  assert.equal(feed.length, 2, "lesson event + streak milestone");
  await call("ben", "reportActivity", { day: TODAY, days: { [TODAY]: 10, [addDays(TODAY, -1)]: 10 }, xpDays: { [TODAY]: 40 } });
  assert.equal((await fails("ana", "reportActivity", { day: "yesterday" })).error.message, "Bad date.");
});

test("friends: search, request, accept, overview", async () => {
  const found = await call("ben", "searchUsers", { query: "@ana", ...days });
  assert.equal(found.users.length, 1);
  assert.equal(found.users[0].uid, "ana");
  assert.equal(found.users[0].relation, "none");
  assert.equal(found.users[0].weekXP, 142, "112 today + 30 yesterday (Monday)");

  assert.deepEqual(await call("ben", "sendFriendRequest", { handle: "ana.lopez" }), { relation: "requested" });
  assert.equal((await fails("ben", "sendFriendRequest", { handle: "nobody" })).error.status, "NOT_FOUND");
  const pending = await call("ana", "friendsOverview", days);
  assert.deepEqual(pending.incoming.map((p: { uid: string }) => p.uid), ["ben"]);
  assert.equal((await fails("ben", "respondFriendRequest", { uid: "ana", accept: true })).error.status, "NOT_FOUND");
  assert.deepEqual(await call("ana", "respondFriendRequest", { uid: "ben", accept: true }), { relation: "friend" });

  const ov = await call("ben", "friendsOverview", days);
  assert.equal(ov.me.uid, "ben");
  assert.equal(ov.friends.length, 1);
  const ana = ov.friends[0];
  assert.equal(ana.uid, "ana");
  assert.equal(ana.streak, 3);
  assert.equal(ana.weekMinutes, 14 + 20);
  assert.equal(ana.friendStreak, 2, "both practised today and yesterday");
  assert.equal(ana.unread, 0);
  assert.ok(ov.feed.some((f: { type: string; uid: string }) => f.type === "lesson" && f.uid === "ana"));
  assert.ok(ov.feed.some((f: { type: string; params: { days: string } }) => f.type === "streak" && f.params.days === "3"));
});

test("contacts are matched by email hash", async () => {
  const { createHash } = await import("crypto");
  const h = createHash("sha256").update("ana@example.com").digest("hex");
  const r = await call("ben", "matchContacts", { hashes: [h, "not-a-hash"], ...days });
  assert.deepEqual(r.users.map((u: { uid: string; relation: string }) => [u.uid, u.relation]), [["ana", "friend"]]);
});

test("cheers toggle, nudges arrive once a day", async () => {
  const ov = await call("ben", "friendsOverview", days);
  const item = ov.feed.find((f: { uid: string }) => f.uid === "ana");
  assert.deepEqual(await call("ben", "cheer", { owner: "ana", id: item.id }), { cheered: true, cheers: 1 });
  assert.deepEqual(await call("ben", "cheer", { owner: "ana", id: item.id }), { cheered: false, cheers: 0 });
  assert.equal((await fails("ben", "cheer", { owner: "ana", id: "gone" })).error.status, "NOT_FOUND");
  assert.equal((await fails("carl", "cheer", { owner: "ana", id: item.id })).error.status, "PERMISSION_DENIED");

  await call("ben", "nudge", { uid: "ana", day: TODAY });
  await call("ben", "nudge", { uid: "ana", day: TODAY });
  const nudges = (await call("ana", "friendsOverview", days)).nudges;
  assert.equal(nudges.length, 1);
  assert.equal(nudges[0].name, "Ana López");
  await call("ana", "markNudgesSeen", { ids: [nudges[0].id] });
  assert.equal((await call("ana", "friendsOverview", days)).nudges.length, 0);
});

test("chat: messages, unread counts, no AI correction without a plan", async () => {
  const sent = await call("ben", "sendChatMessage", { uid: "ana", text: "  Hola, que tal?  ", language: { name: "Spanish" } });
  assert.equal(sent.correction, null);
  assert.equal((await call("ana", "friendsOverview", days)).friends[0].unread, 1);
  const msgs = await call("ana", "chatMessages", { uid: "ben" });
  assert.deepEqual(msgs.messages.map((m: { text: string; mine: boolean }) => [m.text, m.mine]), [["Hola, que tal?", false]]);
  const after = (await call("ana", "friendsOverview", days)).friends[0];
  assert.equal(after.unread, 0);
  assert.equal(after.lastMessage, "Hola, que tal?");
  assert.equal(after.lastFromMe, false);
  assert.equal((await fails("ben", "sendChatMessage", { uid: "ana", text: "   " })).error.status, "INVALID_ARGUMENT");
  assert.equal((await fails("carl", "chatMessages", { uid: "ana" })).error.status, "PERMISSION_DENIED");
});

test("challenges and shared plans", async () => {
  const { id } = await call("ana", "createChallenge", { type: "duel", friends: ["ben"], day: WEEK });
  let list = (await call("ben", "friendsOverview", days)).challenges;
  assert.equal(list.length, 1);
  assert.equal(list[0].invitedMe, true);
  assert.equal(list[0].endDay, addDays(WEEK, 6));
  await call("ben", "respondChallenge", { id, accept: true });
  list = (await call("ana", "friendsOverview", days)).challenges;
  assert.deepEqual(list[0].rows.map((r: { uid: string; value: number }) => [r.uid, r.value]), [["ana", 2], ["ben", 2]]);
  await call("ben", "leaveChallenge", { id });
  assert.equal((await fails("ana", "createChallenge", { type: "duel", friends: ["carl"], day: WEEK })).error.status, "PERMISSION_DENIED");
  assert.equal((await fails("ana", "createChallenge", { type: "chess", friends: ["ben"], day: WEEK })).error.status, "INVALID_ARGUMENT");

  const { planId } = await call("ana", "sharePlan", { lang: "es", title: "My week", plan: '{"days":[]}' });
  assert.deepEqual(await call("ben", "getSharedPlan", { planId }), { lang: "es", plan: '{"days":[]}' });
  assert.equal((await fails("carl", "getSharedPlan", { planId })).error.status, "PERMISSION_DENIED");
  const sprint = await call("ana", "createChallenge", { type: "sprint", friends: ["ben"], day: WEEK, endDay: addDays(WEEK, 3), goalMinutes: int64(5) });
  assert.equal(fake.docs.get(`challenges/${sprint.id}`)!.goalMinutes, 10, "goal is clamped");
});

test("leagues: join with XP, everyone ranked", async () => {
  const none = await call("carl", "leagueStatus", { weekStart: WEEK, day: TODAY });
  assert.equal(none.joined, false);
  assert.equal(none.tierName, "Bronze");
  const a = await call("ana", "leagueStatus", { weekStart: WEEK, day: TODAY });
  const b = await call("ben", "leagueStatus", { weekStart: WEEK, day: TODAY });
  assert.equal(a.joined, true);
  assert.deepEqual(b.members.map((m: { uid: string; xp: number }) => [m.uid, m.xp]), [["ana", 142], ["ben", 40]]);
  assert.equal(b.members[1].me, true);
  assert.equal(b.promote, 7);
});

test("public profile, privacy and the shared web page", async () => {
  const p = await call("ben", "publicProfile", { handle: "ana.lopez", ...days });
  assert.equal(p.relation, "friend");
  assert.equal(p.friendsCount, 1);
  assert.equal(p.stats.totalXP, 112);
  assert.equal(p.league, 0);
  assert.equal((await call("ana", "publicProfile", { uid: "ana", ...days })).relation, "me");

  let html = await (await srv.fetch("/u/ana.lopez")).text();
  assert.ok(html.includes("Ana L") && html.includes("112") && html.includes("Bronze"));

  await call("ana", "setPrivacy", { shareActivity: false });
  const hidden = await call("ben", "publicProfile", { uid: "ana", ...days });
  assert.equal(hidden.stats, null);
  assert.equal(hidden.streak, 0);
  html = await (await srv.fetch("/u/ana.lopez")).text();
  assert.ok(html.includes("keeps their activity private"));
  await call("ana", "setPrivacy", { shareActivity: true });
  assert.equal((await fails("ben", "publicProfile", { handle: "ghost", ...days })).error.status, "NOT_FOUND");
});

test("profile photo upload and download", async () => {
  const jpeg = Buffer.alloc(500, 7);
  jpeg[0] = 0xff; jpeg[1] = 0xd8;
  const { photo } = await call("ana", "setAvatar", { image: jpeg.toString("base64") });
  assert.ok(photo > 0);
  const r = await srv.fetch("/avatar/ana", { headers: { Authorization: "Bearer token:ben" } });
  assert.equal(r.status, 200);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), jpeg);
  assert.equal((await call("ben", "friendsOverview", days)).friends[0].photo, photo);
  assert.deepEqual(await call("ana", "setAvatar", { image: null }), { photo: 0 });
  assert.equal((await srv.fetch("/avatar/ana", { headers: { Authorization: "Bearer token:ben" } })).status, 404);
});

test("devices and feedback", async () => {
  const { id } = await call("ana", "registerDevice", { id: "iphone-1", name: "Ana's iPhone", model: "iPhone17,1", os: "iOS 26.1" });
  assert.equal(id, "iphone-1");
  const list = await call("ana", "listDevices");
  assert.deepEqual(list.devices.map((d: { id: string; name: string }) => [d.id, d.name]), [["iphone-1", "Ana's iPhone"]]);
  await call("ana", "removeDevice", { id });
  assert.equal((await call("ana", "listDevices")).devices.length, 0);
  assert.deepEqual(await call("ana", "sendFeedback", { text: "Love it", app: "1.0" }), { ok: true });
  assert.equal((await fails("ana", "sendFeedback", { text: "" })).error.status, "INVALID_ARGUMENT");
});

test("removing a friend", async () => {
  assert.deepEqual(await call("ben", "removeFriend", { uid: "ana" }), { relation: "none" });
  assert.equal((await call("ben", "friendsOverview", days)).friends.length, 0);
});

test("AI features explain that Sign in with ChatGPT isn't set up", async () => {
  for (const name of ["weeklyPlan", "lesson", "tutorTurn", "checkTranslation", "chatgptAuthStart"]) {
    const { status, error } = await fails("ana", name, { language: { name: "Spanish" } });
    assert.equal(status, 400, name);
    assert.equal(error.status, "FAILED_PRECONDITION", name);
    assert.deepEqual(error.details, { reason: "not-configured" }, name);
  }
  assert.deepEqual(await call("ana", "chatgptStatus"), { connected: false, email: null, model: null });
  assert.deepEqual(await call("ana", "chatgptDisconnect"), { connected: false });
  assert.deepEqual(await call("anon", "chatgptAuthFinish", { state: "unknown" }), { ok: false });
});

test("cached content works without a plan", async () => {
  await fake.collection("vocabTranslations").doc("es").collection("words").doc("w1").set({ t: ["hola"] });
  const ids = [...(await import("../src/modules/vocab/word-list")).wordList().keys()].slice(0, 2);
  await fake.collection("vocabTranslations").doc("es").collection("words").doc(ids[0]).set({ t: ["perro"] });
  const tr = await call("ana", "translateWords", { ids, targetLanguage: "es-ES" });
  assert.deepEqual(tr, { language: "es", translations: { [ids[0]]: ["perro"] } });

  const unit = { id: "es-food", title: "Food", tip: "", topic: "food", words: [], sentences: [] };
  await fake.collection("courseUnits").doc("es-food").set({ unit });
  assert.deepEqual(await call("ana", "courseUnit", { language: { key: "es", name: "Spanish" }, topicId: "food" }), unit);
  const miss = await fails("ana", "courseUnit", { language: { key: "es", name: "Spanish" }, topicId: "travel" });
  assert.equal(miss.error.status, "FAILED_PRECONDITION");
  assert.equal((await fails("ana", "courseUnit", {})).error.status, "INVALID_ARGUMENT");
});
