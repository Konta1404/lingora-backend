import { test } from "node:test";
import assert from "node:assert/strict";
import { callables, callableNames } from "../src/api/registry";

/** The names the shipped iOS app calls. Removing or renaming one breaks installed apps. */
const SHIPPED = [
  "weeklyPlan", "adaptToday", "lesson", "checkWriting", "tutorTurn", "correctMessage", "translateWords", "checkTranslation",
  "chatgptAuthStart", "chatgptAuthFinish", "chatgptStatus", "chatgptDisconnect", "profileSync", "setHandle", "reportActivity",
  "searchUsers", "matchContacts", "sendFriendRequest", "respondFriendRequest", "removeFriend", "friendsOverview", "cheer",
  "nudge", "markNudgesSeen", "createChallenge", "respondChallenge", "leaveChallenge", "sharePlan", "getSharedPlan",
  "chatMessages", "sendChatMessage", "registerDevice", "listDevices", "removeDevice", "setPrivacy", "setAvatar",
  "courseUnit", "leagueStatus", "publicProfile", "sendFeedback", "explainAnswer", "callFeedback",
];

test("every shipped callable still exists", () => {
  for (const name of SHIPPED) assert.ok(callableNames.includes(name as never), `missing callable ${name}`);
  assert.equal(callableNames.length, SHIPPED.length, "new callables must be added to SHIPPED once the app uses them");
});

test("only the sign-in start and finish are public", () => {
  const open = callableNames.filter((n) => callables[n].access === "public").sort();
  assert.deepEqual(open, ["chatgptAuthFinish", "chatgptAuthStart"]);
});

test("signed-in callables reject anonymous callers before touching any data", async () => {
  for (const name of callableNames.filter((n) => callables[n].access === "user")) {
    await assert.rejects(callables[name].handle({}, { uid: null }), (e: Error & { code?: string }) => e.code === "unauthenticated", name);
  }
});

test("the Firebase entry point exports every callable plus the OAuth callback", async () => {
  const mod = (await import("../src/index")) as Record<string, unknown>;
  const exported = Object.keys(mod).filter((k) => k !== "__esModule").sort();
  assert.deepEqual(exported, [...callableNames, "chatgptCallback"].sort());
});
