import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { publicCallable, userCallable } from "../src/api/define";
import { AppError, PlanError } from "../src/core/errors";
import { decodeCallable } from "../src/http/callable-protocol";
import { serve } from "./helpers";

const echo = userCallable(async (d, u) => ({ data: d, uid: u.uid, email: u.email ?? null }));

let srv: Awaited<ReturnType<typeof serve>>;

before(async () => {
  srv = await serve({
    callables: {
      echo,
      whoami: publicCallable(async (_d, ctx) => ({ uid: ctx.uid })),
      nothing: userCallable(async () => undefined),
      missing: userCallable(async () => {
        throw new AppError("not-found", "No one with that username.");
      }),
      plan: userCallable(async () => {
        throw new PlanError("Connect your ChatGPT account to use AI features.", "not-connected");
      }),
      crash: userCallable(async () => {
        throw new Error("db down");
      }),
    },
    verifyIdToken: async (token) => {
      if (token === "good") return { uid: "u1", email: "a@b.c" };
      throw new Error("bad token");
    },
    getAvatar: async (uid) => (uid === "u1" ? { data: Buffer.from([0xff, 0xd8, 1]), type: "image/jpeg" } : null),
    webProfile: async (handle) =>
      handle === "vesko"
        ? {
            name: "Vesko <script>", handle: "vesko", hue: 10, langs: ["de", "x-klingon"], joined: new Date("2026-01-05"),
            shares: true, streak: 4, totalXP: 112, league: "Silver", friendsCount: 2, lessons: 9, bestStreak: 6, achievements: 1,
          }
        : null,
    chatgptCallback: async (params) => `lingora://chatgpt?status=ok&state=${params.get("state")}`,
  });
});
after(() => srv.close());

test("health and root", async () => {
  assert.equal(await (await srv.fetch("/healthz")).text(), "ok");
  assert.deepEqual(await (await srv.fetch("/")).json(), { service: "lingora-backend", ok: true });
  assert.equal((await srv.fetch("/")).headers.get("x-powered-by"), null);
});

test("unknown callable", async () => {
  const r = await srv.call("nope", {}, "good");
  assert.equal(r.status, 404);
  assert.deepEqual(await r.json(), { error: { status: "NOT_FOUND", message: "Unknown function" } });
  assert.equal((await srv.call("toString", {}, "good")).status, 404);
});

test("signed-in callable without a token", async () => {
  const r = await srv.call("echo", {});
  assert.equal(r.status, 401);
  assert.deepEqual(await r.json(), { error: { status: "UNAUTHENTICATED", message: "Sign in to use ChatGPT features." } });
});

test("invalid token", async () => {
  const r = await srv.call("whoami", {}, "expired");
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error.message, "Your session expired. Sign in again.");
});

test("public callable works with and without a user", async () => {
  assert.deepEqual(await (await srv.call("whoami", {})).json(), { result: { uid: null } });
  assert.deepEqual(await (await srv.call("whoami", {}, "good")).json(), { result: { uid: "u1" } });
});

test("result envelope, Int64 numbers from the iOS SDK are unwrapped", async () => {
  const data = { day: "2026-11-24", days: { "2026-11-24": { "@type": "type.googleapis.com/google.protobuf.Int64Value", value: "21" } }, list: [1, { "@type": "x.Int64Value", value: "-3" }] };
  const r = await srv.call("echo", data, "good");
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { result: { data: { day: "2026-11-24", days: { "2026-11-24": 21 }, list: [1, -3] }, uid: "u1", email: "a@b.c" } });
});

test("undefined results become null; missing data becomes {}", async () => {
  assert.deepEqual(await (await srv.call("nothing", undefined, "good")).json(), { result: null });
  const r = await srv.fetch("/echo", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer good" }, body: "{}" });
  assert.deepEqual((await r.json()).result.data, {});
});

test("errors use the callable format and HTTP status", async () => {
  const nf = await srv.call("missing", {}, "good");
  assert.equal(nf.status, 404);
  assert.deepEqual(await nf.json(), { error: { status: "NOT_FOUND", message: "No one with that username." } });
  const plan = await srv.call("plan", {}, "good");
  assert.equal(plan.status, 400);
  assert.deepEqual((await plan.json()).error, { status: "FAILED_PRECONDITION", message: "Connect your ChatGPT account to use AI features.", details: { reason: "not-connected" } });
  const crash = await srv.call("crash", {}, "good");
  assert.equal(crash.status, 500);
  assert.equal((await crash.json()).error.status, "INTERNAL");
});

test("malformed and oversized bodies", async () => {
  const bad = await srv.fetch("/echo", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{oops" });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.status, "INVALID_ARGUMENT");
  const big = await srv.call("echo", { blob: "x".repeat(300_000) }, "good");
  assert.equal(big.status, 413);
});

test("avatar needs a valid token", async () => {
  assert.equal((await srv.fetch("/avatar/u1")).status, 401);
  const ok = await srv.fetch("/avatar/u1", { headers: { Authorization: "Bearer good" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "image/jpeg");
  assert.match(ok.headers.get("cache-control") ?? "", /immutable/);
  assert.equal((await srv.fetch("/avatar/u2", { headers: { Authorization: "Bearer good" } })).status, 404);
});

test("shared profile page escapes everything and links into the app", async () => {
  const r = await srv.fetch("/u/Vesko");
  const html = await r.text();
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /text\/html/);
  assert.ok(html.includes("Vesko &#60;script&#62;"));
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes('href="lingora://add/vesko"'));
  assert.ok(html.includes("German") && html.includes("klingon"));
  assert.ok(html.includes("112") && html.includes("Silver"));
  const unknown = await (await srv.fetch("/u/%3Cb%3Enobody")).text();
  assert.ok(unknown.includes("Add @bnobody on Lingora."));
});

test("ChatGPT callback redirects into the app", async () => {
  const r = await srv.fetch("/chatgptCallback?state=abc&code=1");
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "lingora://chatgpt?status=ok&state=abc");
});

test("decodeCallable leaves normal values alone", () => {
  assert.deepEqual(decodeCallable({ a: [1, "2", null, { b: true }] }), { a: [1, "2", null, { b: true }] });
});
