/**
 * Lingora backend as a plain Node web server (for Render or any Node host).
 *
 * It serves the same functions as Firebase Cloud Functions, using the Firebase "callable" protocol:
 *   POST /<functionName>   body {"data": {...}}   header Authorization: Bearer <Firebase ID token>
 *   → {"result": ...}  or  {"error": {"status", "message", "details"}}
 * so the iOS app's Functions SDK can call it unchanged. Firebase Auth and Firestore stay in Firebase.
 *
 * Required env: FIREBASE_SERVICE_ACCOUNT (the service-account JSON), TOKEN_ENC_KEY, CHATGPT_CALLBACK_URL.
 */
import express from "express";
import { getAuth } from "firebase-admin/auth";
import { HttpsError } from "firebase-functions/v2/https";
import * as fns from "./index";
import { webProfile, getAvatar } from "./social";

type Callable = { run: (req: unknown) => unknown };

const CALLABLES: Record<string, Callable> = {
  weeklyPlan: fns.weeklyPlan,
  adaptToday: fns.adaptToday,
  lesson: fns.lesson,
  checkWriting: fns.checkWriting,
  tutorTurn: fns.tutorTurn,
  correctMessage: fns.correctMessage,
  translateWords: fns.translateWords,
  checkTranslation: fns.checkTranslation,
  chatgptAuthStart: fns.chatgptAuthStart,
  chatgptAuthFinish: fns.chatgptAuthFinish,
  chatgptStatus: fns.chatgptStatus,
  chatgptDisconnect: fns.chatgptDisconnect,
  profileSync: fns.profileSync,
  setHandle: fns.setHandle,
  reportActivity: fns.reportActivity,
  searchUsers: fns.searchUsers,
  matchContacts: fns.matchContacts,
  sendFriendRequest: fns.sendFriendRequest,
  respondFriendRequest: fns.respondFriendRequest,
  removeFriend: fns.removeFriend,
  friendsOverview: fns.friendsOverview,
  cheer: fns.cheer,
  nudge: fns.nudge,
  markNudgesSeen: fns.markNudgesSeen,
  createChallenge: fns.createChallenge,
  respondChallenge: fns.respondChallenge,
  leaveChallenge: fns.leaveChallenge,
  sharePlan: fns.sharePlan,
  getSharedPlan: fns.getSharedPlan,
  chatMessages: fns.chatMessages,
  sendChatMessage: fns.sendChatMessage,
  registerDevice: fns.registerDevice,
  listDevices: fns.listDevices,
  removeDevice: fns.removeDevice,
  setPrivacy: fns.setPrivacy,
  setAvatar: fns.setAvatar,
  courseUnit: fns.courseUnit,
  leagueStatus: fns.leagueStatus,
  publicProfile: fns.publicProfile,
  sendFeedback: fns.sendFeedback,
  explainAnswer: fns.explainAnswer,
  callFeedback: fns.callFeedback,
} as unknown as Record<string, Callable>;

const HTTP_STATUS: Record<string, number> = {
  "invalid-argument": 400, "failed-precondition": 400, "out-of-range": 400, unauthenticated: 401,
  "permission-denied": 403, "not-found": 404, "already-exists": 409, aborted: 409,
  "resource-exhausted": 429, cancelled: 499, unimplemented: 501, unavailable: 503,
  "deadline-exceeded": 504, internal: 500, unknown: 500, "data-loss": 500,
};
const STATUS_NAME: Record<string, string> = {
  "invalid-argument": "INVALID_ARGUMENT", "failed-precondition": "FAILED_PRECONDITION", "out-of-range": "OUT_OF_RANGE",
  unauthenticated: "UNAUTHENTICATED", "permission-denied": "PERMISSION_DENIED", "not-found": "NOT_FOUND",
  "already-exists": "ALREADY_EXISTS", aborted: "ABORTED", "resource-exhausted": "RESOURCE_EXHAUSTED",
  cancelled: "CANCELLED", unimplemented: "UNIMPLEMENTED", unavailable: "UNAVAILABLE",
  "deadline-exceeded": "DEADLINE_EXCEEDED", internal: "INTERNAL", unknown: "UNKNOWN", "data-loss": "DATA_LOSS",
};

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(express.json({ limit: "256kb" }));

app.get("/", (_req, res) => {
  res.json({ service: "lingora-backend", ok: true });
});
app.get("/healthz", (_req, res) => {
  res.send("ok");
});

// OpenAI redirects the browser here after Sign in with ChatGPT.
app.get("/chatgptCallback", (req, res) => (fns.chatgptCallback as unknown as express.RequestHandler)(req, res, () => undefined));

// Profile photos, for signed-in users: GET /avatar/<uid>?v=<version> with "Authorization: Bearer <ID token>".
app.get("/avatar/:uid", async (req, res) => {
  const token = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
  try {
    await getAuth().verifyIdToken(token);
  } catch {
    res.status(401).end();
    return;
  }
  const a = await getAvatar(String(req.params.uid)).catch(() => null);
  if (!a) {
    res.status(404).end();
    return;
  }
  res.set("Cache-Control", "private, max-age=31536000, immutable").type(a.type).send(a.data);
});

// Invite links: https://<backend>/u/<handle> opens the app (lingora://add/<handle>).
const esc = (t: string) => t.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
app.get("/u/:handle", async (req, res) => {
  const handle = String(req.params.handle).toLowerCase().replace(/[^a-z0-9._]/g, "").slice(0, 20);
  let w: Awaited<ReturnType<typeof webProfile>> = null;
  try {
    w = await webProfile(handle);
  } catch {
    w = null;
  }
  const deep = `lingora://add/${handle}`;
  const langName = (code: string) => {
    if (code.startsWith("x-")) return code.slice(2).replace(/-/g, " ");
    try {
      return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
    } catch {
      return code;
    }
  };
  const stat = (icon: string, value: string | number, label: string) =>
    `<div class="s"><div class="i">${icon}</div><b>${esc(String(value))}</b><span>${label}</span></div>`;
  let body = `<h1>Lingora</h1><p>Add @${esc(handle)} on Lingora.</p>`;
  if (w) {
    const first = esc(w.name.split(" ")[0] || w.name);
    const since = w.joined ? `<p class="m">Learning since ${w.joined.toLocaleDateString("en", { month: "long", year: "numeric" })}</p>` : "";
    const langs = w.langs.length ? `<div class="l">${w.langs.map((l) => `<span>${esc(langName(l))}</span>`).join("")}</div>` : "";
    const grid = w.shares
      ? `<div class="g">${stat("🔥", w.streak, "day streak")}${stat("⚡", w.totalXP, "total XP")}${stat("🛡️", w.league ?? "—", "league")}${stat("👥", w.friendsCount, "friends")}${stat("📘", w.lessons, "lessons finished")}${stat("🏆", w.bestStreak, "best streak")}</div>` +
        (w.achievements ? `<p class="m">${w.achievements} achievement${w.achievements === 1 ? "" : "s"} unlocked</p>` : "")
      : `<p class="m">${first} keeps their activity private.</p>`;
    body = `<div class="a" style="background:oklch(0.58 0.07 ${Math.round(w.hue)})">${esc((w.name[0] ?? "?").toUpperCase())}</div>
<h1>${esc(w.name)}</h1><p class="m">@${esc(w.handle)}</p>${since}${langs}${grid}
<p>${first} wants to practise languages with you.</p>`;
  }
  res.set("Cache-Control", "no-store").type("html").send(`<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${w ? esc(w.name) + " on Lingora" : "Lingora"}</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#f6f1e8;color:#1d1a16;display:grid;place-items:center;min-height:100vh;margin:0}
main{max-width:380px;width:100%;box-sizing:border-box;padding:32px 20px;text-align:center}h1{margin:12px 0 2px;font-size:26px}.m{color:#7a7166;font-size:14px;margin:4px 0}
.a{width:96px;height:96px;border-radius:50%;margin:0 auto;display:grid;place-items:center;color:#fff;font-size:40px;font-weight:700}
.l{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin:12px 0}.l span{background:#e3ecdf;color:#2f5240;font-weight:600;font-size:13px;padding:6px 10px;border-radius:999px}
.g{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:16px 0;text-align:left}.s{background:#fff;border-radius:16px;padding:14px}.s b{display:block;font-size:20px;margin-top:4px}.s span{font-size:12px;color:#7a7166;font-weight:600}
a{display:inline-block;margin-top:16px;padding:14px 22px;border-radius:999px;background:#1d1a16;color:#fff;text-decoration:none;font-weight:600}</style>
</head><body><main>${body}
<a href="${deep}">Open in Lingora</a><p class="m" style="margin-top:24px">Install Lingora on your iPhone first, then tap the button.</p></main></body></html>`);
});

// The Firebase client SDKs send 64-bit integers as {"@type": ".../google.protobuf.Int64Value", "value": "21"}.
// Firebase's own callable runtime unwraps them; this server has to do it itself.
function decodeCallable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decodeCallable);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const t = o["@type"];
    if (typeof t === "string" && t.endsWith("Int64Value") && "value" in o) return Number(o.value);
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) out[k] = decodeCallable(x);
    return out;
  }
  return v;
}

app.post("/:name", async (req, res) => {
  const fn = CALLABLES[req.params.name];
  if (!fn) {
    res.status(404).json({ error: { status: "NOT_FOUND", message: "Unknown function" } });
    return;
  }
  try {
    let auth: { uid: string; token: unknown } | undefined;
    const header = req.get("authorization") ?? "";
    if (header.startsWith("Bearer ")) {
      try {
        const token = await getAuth().verifyIdToken(header.slice(7));
        auth = { uid: token.uid, token };
      } catch {
        throw new HttpsError("unauthenticated", "Your session expired. Sign in again.");
      }
    }
    const result = await fn.run({ data: decodeCallable(req.body?.data ?? {}), auth, rawRequest: req, acceptsStreaming: false });
    res.json({ result: result ?? null });
  } catch (e) {
    const err = e instanceof HttpsError ? e : new HttpsError("internal", e instanceof Error ? e.message : String(e));
    if (!(e instanceof HttpsError)) console.error(`/${req.params.name} failed`, e);
    res.status(HTTP_STATUS[err.code] ?? 500).json({
      error: { status: STATUS_NAME[err.code] ?? "INTERNAL", message: err.message, details: err.details },
    });
  }
});

const port = Number(process.env.PORT) || 8080;
app.listen(port, () => console.log(`Lingora backend listening on :${port}`));
