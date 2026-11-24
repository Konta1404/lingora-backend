import { test } from "node:test";
import assert from "node:assert/strict";
import { outcome, ranked, TIERS } from "../src/modules/leagues/league.logic";
import { ProfileDoc } from "../src/modules/profiles/profile.model";

const order = (n: number, xpOf = (i: number) => (n - i) * 10) => Array.from({ length: n }, (_, i) => ({ uid: `u${i}`, xp: xpOf(i) }));

test("top 7 with XP are promoted", () => {
  assert.deepEqual(outcome(order(20), "u0", 2), { tier: 3, result: "promoted" });
  assert.deepEqual(outcome(order(20), "u6", 2), { tier: 3, result: "promoted" });
  assert.deepEqual(outcome(order(20), "u7", 2), { tier: 2, result: "stayed" });
});

test("no promotion beyond the top tier", () => {
  assert.equal(outcome(order(20), "u0", TIERS.length - 1).result, "stayed");
});

test("bottom 5 of a big league are demoted, small leagues only demote zero XP", () => {
  assert.deepEqual(outcome(order(20), "u15", 3), { tier: 2, result: "demoted" });
  assert.equal(outcome(order(20), "u14", 3).result, "stayed");
  assert.equal(outcome(order(9), "u8", 3).result, "stayed");
  assert.equal(outcome(order(9, (i) => (i === 8 ? 0 : 10)), "u8", 3).result, "demoted");
});

test("Bronze never demotes; missing members drop a tier", () => {
  assert.equal(outcome(order(20), "u19", 0).result, "stayed");
  assert.deepEqual(outcome(order(5), "ghost", 4), { tier: 3, result: "demoted" });
});

test("ranking by this week's XP", () => {
  const ps = new Map<string, ProfileDoc>([
    ["a", { xpDays: { "2026-11-23": 5, "2026-11-16": 500 } }],
    ["b", { xpDays: { "2026-11-29": 20 } }],
  ]);
  assert.deepEqual(ranked(["a", "b", "c"], ps, "2026-11-23"), [{ uid: "b", xp: 20 }, { uid: "a", xp: 5 }, { uid: "c", xp: 0 }]);
});
