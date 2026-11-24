import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "crypto";
import { encrypt, decrypt } from "../src/infra/crypto";
import { collectOutput, upstreamError } from "../src/infra/openai/client";
import { sseEvents } from "../src/infra/openai/sse";
import { AppError, AIError, PlanError, toAppError } from "../src/core/errors";
import { pickModel } from "../src/modules/chatgpt/models";
import { chatgptUid } from "../src/modules/chatgpt/auth-flow";
import { normalizeLang, wordList, headword } from "../src/modules/vocab/word-list";
import { unitKey, shapeUnit } from "../src/modules/course/course-unit";

test("token encryption round-trips and detects tampering", () => {
  const key = randomBytes(32).toString("base64");
  const box = encrypt('{"access":"secret"}', key);
  assert.match(box, /^v1\./);
  assert.equal(decrypt(box, key), '{"access":"secret"}');
  assert.notEqual(encrypt("x", key), encrypt("x", key));
  const parts = box.split(".");
  parts[3] = Buffer.from("tampered").toString("base64");
  assert.throws(() => decrypt(parts.join("."), key));
  assert.throws(() => decrypt(box, randomBytes(32).toString("base64")));
  assert.throws(() => encrypt("x", "short"), /32 bytes/);
});

test("errors map to callable codes", () => {
  assert.equal(toAppError(new PlanError("m", "limit")).code, "resource-exhausted");
  assert.deepEqual(toAppError(new PlanError("m", "not-connected")).details, { reason: "not-connected" });
  assert.equal(toAppError(new PlanError("m", "revoked")).code, "failed-precondition");
  assert.equal(toAppError(new PlanError("m", "failed")).code, "internal");
  assert.equal(toAppError(new AIError("m", 429)).code, "resource-exhausted");
  assert.equal(toAppError(new Error("boom")).code, "internal");
  const app = new AppError("not-found", "x");
  assert.equal(toAppError(app), app);
});

test("OpenAI errors become plan errors", () => {
  const limit = upstreamError(429, {});
  assert.ok(limit instanceof PlanError && limit.code === "limit");
  const notEligible = upstreamError(403, { error: { code: "subscription_sharing_user_not_eligible" } });
  assert.ok(notEligible instanceof PlanError && notEligible.code === "not-eligible");
  const revoked = upstreamError(401, {});
  assert.ok(revoked instanceof PlanError && revoked.code === "revoked");
  const other = upstreamError(500, { error: { message: "down" } });
  assert.ok(other instanceof AIError && other.message === "down");
});

const stream = (...chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
      c.close();
    },
  });

test("SSE parsing survives chunk boundaries", async () => {
  const events: unknown[] = [];
  for await (const e of sseEvents(stream('event: x\ndata: {"type":"a"', '}\n\ndata: [DONE]\n', 'data: {"type":"b"}'))) events.push(e);
  assert.deepEqual(events, [{ type: "a" }, { type: "b" }]);
});

async function* evs(...e: unknown[]) {
  yield* e;
}

test("completion text comes from the final event, else the deltas", async () => {
  const done = { type: "response.completed", response: { output: [{ content: [{ type: "output_text", text: '{"ok":true}' }] }] } };
  assert.equal(await collectOutput(evs({ type: "response.output_text.delta", delta: '{"ok":' }, done)), '{"ok":true}');
  assert.equal(await collectOutput(evs({ type: "response.output_text.delta", delta: "{}" })), "{}");
  await assert.rejects(collectOutput(evs({ type: "response.refusal.done" })), /declined/);
  await assert.rejects(collectOutput(evs({ type: "response.failed", response: { error: { message: "nope" } } })), /nope/);
});

test("model choice", () => {
  assert.equal(pickModel(["gpt-5", "gpt-5-mini"], ["gpt-5-mini", "gpt-5"]), "gpt-5-mini");
  assert.equal(pickModel(["gpt-4o-audio", "gpt-4.1"], ["gpt-5-mini"]), "gpt-4.1");
  assert.equal(pickModel([], ["gpt-5-mini"]), "gpt-5-mini");
  assert.match(chatgptUid("iss", "cid", "sub"), /^chatgpt_[0-9a-f]{28}$/);
});

test("vocabulary data loads and languages normalise", () => {
  assert.ok(wordList().size > 1000);
  const noun = [...wordList().values()].find((w) => w.pos === "noun")!;
  assert.ok(headword(noun).startsWith(`${noun.article} `));
  assert.equal(normalizeLang("en-US"), "en");
  assert.equal(normalizeLang("sr_latn_ME"), "sr-Latn");
  assert.equal(normalizeLang(""), "en");
});

test("course unit cache keys and shaping", () => {
  assert.equal(unitKey({ language: { key: "de", name: "German" }, level: "B1", topicId: "food-2" }).id, "de-food-2");
  assert.equal(unitKey({ language: { name: "Klingon" }, level: "Z9", index: 999 }).id, "klingon-A1-200");
  const item = { t: "x", en: "y" };
  const u = shapeUnit("de-1", "", { title: "T", tip: "tip", words: Array(12).fill(item), sentences: Array(9).fill(item) });
  assert.equal(u.words.length, 10);
  assert.equal(u.sentences.length, 8);
  assert.equal(u.topic, null);
  assert.throws(() => shapeUnit("x", "", { title: "", tip: "", words: [item], sentences: [] }), /too short/);
});
