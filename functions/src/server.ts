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
import { profileByHandle, getAvatar } from "./social";

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
  let name = "";
  try {
    name = (await profileByHandle(handle))?.name ?? "";
  } catch {
    name = "";
  }
  const deep = `lingora://add/${handle}`;
  res.set("Cache-Control", "no-store").type("html").send(`<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Lingora</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#f6f1e8;color:#1d1a16;display:grid;place-items:center;min-height:100vh;margin:0}
main{max-width:340px;padding:32px;text-align:center}a{display:inline-block;margin-top:20px;padding:14px 22px;border-radius:999px;background:#1d1a16;color:#fff;text-decoration:none;font-weight:600}</style>
</head><body><main><h1>Lingora</h1><p>${name ? `<b>${esc(name)}</b> (@${esc(handle)}) wants to practise languages with you.` : `Add @${esc(handle)} on Lingora.`}</p>
<a href="${deep}">Open in Lingora</a><p style="font-size:13px;opacity:.6;margin-top:24px">Install Lingora on your iPhone first, then tap the button.</p></main>
<script>location.href=${JSON.stringify(deep)}</script></body></html>`);
});

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
    const result = await fn.run({ data: req.body?.data ?? {}, auth, rawRequest: req, acceptsStreaming: false });
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
