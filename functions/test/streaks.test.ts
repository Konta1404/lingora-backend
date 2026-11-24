import { test } from "node:test";
import assert from "node:assert/strict";
import { streakOf, pairStreak, sumBetween, activeDaysBetween, mergeReport } from "../src/modules/activity/streaks";
import { addDays, parseDay, isDay } from "../src/core/dates";

const T = "2026-11-24";
const days = (...offsets: number[]) => Object.fromEntries(offsets.map((o) => [addDays(T, -o), 10]));

test("dates", () => {
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.ok(isDay(T));
  assert.ok(!isDay("24.11.2026"));
  assert.throws(() => parseDay("nope"), /Bad date/);
});

test("streak counts consecutive days ending today", () => {
  assert.equal(streakOf(days(0, 1, 2), T), 3);
  assert.equal(streakOf(days(0, 1, 3), T), 2);
  assert.equal(streakOf({}, T), 0);
});

test("streak still counts when today isn't done yet", () => {
  assert.equal(streakOf(days(1, 2, 3), T), 3);
  assert.equal(streakOf(days(2, 3), T), 0);
});

test("a frozen day bridges the gap without adding to the streak", () => {
  assert.equal(streakOf(days(0, 2, 3), T, [addDays(T, -1)]), 3);
  assert.equal(streakOf(days(0, 1), T, [addDays(T, -2)]), 2);
});

test("zero-minute days don't count", () => {
  assert.equal(streakOf({ [T]: 0, [addDays(T, -1)]: 5 }, T), 1);
});

test("pair streak needs both people", () => {
  assert.equal(pairStreak(days(0, 1, 2), days(0, 1), T), 2);
  assert.equal(pairStreak(days(1, 2), days(1, 2, 3), T), 2);
  assert.equal(pairStreak(days(0), {}, T), 0);
});

test("sums and active days in a range", () => {
  const m = { "2026-11-20": 5, "2026-11-21": 0, "2026-11-22": 7, "2026-11-30": 100 };
  assert.equal(sumBetween(m, "2026-11-20", "2026-11-26"), 12);
  assert.equal(sumBetween(m, "2026-11-21"), 107);
  assert.equal(activeDaysBetween(m, "2026-11-20", "2026-11-26"), 2);
});

const empty = { activity: {}, xpDays: {}, frozen: [], lastMilestone: 0 };

test("merge keeps the larger value per day so retries never double-count", () => {
  const stored = { ...empty, activity: { [T]: 20 }, xpDays: { [T]: 50 } };
  const r = mergeReport(stored, { days: { [T]: 15 }, xpDays: { [T]: 80 } }, T);
  assert.equal(r.activity[T], 20);
  assert.equal(r.xpDays[T], 80);
  const again = mergeReport({ ...stored, ...r, lastMilestone: 0 }, { days: { [T]: 15 }, xpDays: { [T]: 80 } }, T);
  assert.deepEqual(again.activity, r.activity);
});

test("merge only accepts recent days and clamps values", () => {
  const r = mergeReport(empty, {
    days: { [addDays(T, -15)]: 10, [addDays(T, 2)]: 10, [addDays(T, 1)]: 10, [T]: 99999, bogus: 5, [addDays(T, -1)]: "7" },
    xpDays: { [T]: 1e9 },
  }, T);
  assert.deepEqual(Object.keys(r.activity).sort(), [addDays(T, -1), T, addDays(T, 1)].sort());
  assert.equal(r.activity[T], 1440);
  assert.equal(r.activity[addDays(T, -1)], 7);
  assert.equal(r.xpDays[T], 5000);
});

test("merge prunes history older than 90 days", () => {
  const old = addDays(T, -91);
  const r = mergeReport({ ...empty, activity: { [old]: 3 }, xpDays: { [old]: 3 }, frozen: [old] }, {}, T);
  assert.deepEqual(r.activity, {});
  assert.deepEqual(r.xpDays, {});
  assert.deepEqual(r.frozen, []);
});

test("merge reports a milestone exactly once, on the day it's reached", () => {
  const seven = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((o) => [addDays(T, -o), 10]));
  const first = mergeReport({ ...empty, lastMilestone: 3 }, { days: seven }, T);
  assert.equal(first.streak, 7);
  assert.equal(first.milestone, 7);
  const again = mergeReport({ ...empty, activity: first.activity, lastMilestone: 7 }, {}, T);
  assert.equal(again.milestone, null);
});

test("merge accepts reported freeze days", () => {
  const r = mergeReport(empty, { days: { [T]: 5, [addDays(T, -2)]: 5 }, frozen: [addDays(T, -1), "junk", 42] }, T);
  assert.deepEqual(r.frozen, [addDays(T, -1)]);
  assert.equal(r.streak, 2);
});
