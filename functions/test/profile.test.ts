import { test } from "node:test";
import assert from "node:assert/strict";
import { toDTO, cleanStats, slugifyName, normalizeHandle, HANDLE, hueFor, emailHash } from "../src/modules/profiles/profile.model";
import { parsePhoto } from "../src/modules/profiles/avatar.service";

const T = "2026-11-24", WEEK = "2026-11-23";
const doc = {
  name: "Vesko", handle: "vesko", hue: 120, langs: ["de"],
  activity: { [T]: 15, "2026-11-23": 10, "2026-11-22": 5 }, xpDays: { [T]: 40, "2026-11-23": 30, "2026-11-22": 99 },
};

test("profile DTO", () => {
  const d = toDTO("u1", doc, T, WEEK, "viewer");
  assert.equal(d.streak, 3);
  assert.equal(d.weekMinutes, 25);
  assert.equal(d.weekXP, 70);
  assert.equal(d.practisedToday, true);
  assert.equal(d.sharesActivity, true);
  assert.equal(d.photo, 0);
});

test("private profiles show zeros to others but not to themselves", () => {
  const priv = { ...doc, shareActivity: false };
  const other = toDTO("u1", priv, T, WEEK, "viewer");
  assert.deepEqual([other.streak, other.weekMinutes, other.weekXP, other.practisedToday], [0, 0, 0, false]);
  assert.equal(other.sharesActivity, false);
  const self = toDTO("u1", priv, T, WEEK, "u1");
  assert.equal(self.weekXP, 70);
});

test("missing profile gets defaults", () => {
  const d = toDTO("abc", undefined, T, WEEK, "x");
  assert.equal(d.name, "Lingora learner");
  assert.equal(d.hue, hueFor("abc"));
  assert.ok(d.hue >= 0 && d.hue < 360);
});

test("stats are clamped and cleaned", () => {
  const s = cleanStats({ totalXP: "112", bestStreak: -4, lessons: 1e12, words: "x", achievements: { " streak7 ": 3, big: 99 } });
  assert.deepEqual(s, { totalXP: 112, bestStreak: 0, lessons: 10_000_000, words: 0, stories: 0, achievements: { streak7: 3, big: 10 } });
});

test("usernames", () => {
  assert.equal(slugifyName("José Müller-Smith"), "jose.muller.smit");
  assert.equal(slugifyName("李"), "learner");
  assert.equal(normalizeHandle("  @Vesko.Kontic225 "), "vesko.kontic225");
  assert.ok(HANDLE.test("vesko.kontic225"));
  assert.ok(!HANDLE.test("ab"));
  assert.ok(!HANDLE.test("has space"));
  assert.equal(emailHash(" A@B.com "), emailHash("a@b.com"));
});

test("photo upload validation", () => {
  const jpeg = Buffer.alloc(200, 1);
  jpeg[0] = 0xff; jpeg[1] = 0xd8;
  assert.equal(parsePhoto(jpeg.toString("base64")).type, "image/jpeg");
  const png = Buffer.alloc(200, 1);
  png[0] = 0x89; png[1] = 0x50;
  assert.equal(parsePhoto(png.toString("base64")).type, "image/png");
  assert.throws(() => parsePhoto(Buffer.alloc(200, 1).toString("base64")), /JPEG or PNG/);
  assert.throws(() => parsePhoto(Buffer.alloc(10).toString("base64")), /too large/);
  assert.throws(() => parsePhoto(Buffer.alloc(200_000, 0xff).toString("base64")), /too large/);
});
