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
