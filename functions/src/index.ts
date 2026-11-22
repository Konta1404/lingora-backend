/**
 * Lingora backend — Firebase Cloud Functions (2nd gen).
 *
 * AI runs on each user's OWN ChatGPT plan through "Sign in with ChatGPT" (OpenAI preview).
 * Users without a connected plan get the app's built-in content; Lingora never pays for their usage.
 *
 * Setup (after OpenAI gives you a client ID — see chatgpt.ts):
 *   firebase functions:secrets:set CHATGPT_CLIENT_SECRET
 *   openssl rand -base64 32 | firebase functions:secrets:set TOKEN_ENC_KEY
 *   and CHATGPT_CLIENT_ID in functions/.env.<project-id>
 */
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { onCall, onRequest, HttpsError, CallableRequest } from "firebase-functions/v2/https";
import { defineSecret, defineString, defineInt } from "firebase-functions/params";
import { setGlobalOptions } from "firebase-functions/v2";
import { complete, obj, str, arr, bool, int, taskSchema, AIError, AIClient, TASK_TYPES } from "./openai";
import { translateWords as translate, checkTranslation as checkTr, vocab } from "./vocab";
import * as chatgpt from "./chatgpt";
import * as social from "./social";

// On Firebase this needs no config. Elsewhere (Render), pass the service-account JSON in FIREBASE_SERVICE_ACCOUNT.
const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
initializeApp(serviceAccount ? { credential: cert(JSON.parse(serviceAccount)) } : undefined);
if (serviceAccount && !process.env.GCLOUD_PROJECT) process.env.GCLOUD_PROJECT = JSON.parse(serviceAccount).project_id;
const REGION = "europe-west1";
setGlobalOptions({ region: REGION, maxInstances: 10 });

const CLIENT_ID = defineString("CHATGPT_CLIENT_ID", { default: "not-set" });
const CLIENT_SECRET = defineSecret("CHATGPT_CLIENT_SECRET");
const TOKEN_ENC_KEY = defineSecret("TOKEN_ENC_KEY");
const DISCOVERY_URL = defineString("CHATGPT_DISCOVERY_URL", { default: "https://auth.openai.com/.well-known/openid-configuration" });
const CALLBACK_URL = defineString("CHATGPT_CALLBACK_URL", { default: "auto" });
const MODELS = defineString("CHATGPT_MODELS", { default: "gpt-5-mini,gpt-5,gpt-6.1-sol" });
const DAILY_LIMIT = defineInt("DAILY_AI_LIMIT", { default: 300 });
const SECRETS = [CLIENT_SECRET, TOKEN_ENC_KEY];

function cfg(): chatgpt.Config {
  const project = process.env.GCLOUD_PROJECT ?? "";
  const callback = CALLBACK_URL.value() !== "auto" ? CALLBACK_URL.value() : (process.env.FUNCTIONS_EMULATOR === "true"
    ? `http://127.0.0.1:5001/${project}/${REGION}/chatgptCallback`
    : `https://${REGION}-${project}.cloudfunctions.net/chatgptCallback`);
  return {
    clientId: CLIENT_ID.value(),
    clientSecret: CLIENT_SECRET.value(),
    encKey: TOKEN_ENC_KEY.value(),
    discoveryUrl: DISCOVERY_URL.value(),
    callbackUrl: callback,
    preferredModels: MODELS.value().split(",").map((m) => m.trim()).filter(Boolean),
  };
}

const isConfigured = () => !!CLIENT_ID.value() && CLIENT_ID.value() !== "not-set";

function requireConfigured() {
  if (!isConfigured()) {
    throw new HttpsError("failed-precondition", "Sign in with ChatGPT isn't set up yet. It needs a client ID from OpenAI.", { reason: "not-configured" });
  }
}

const TONE =
  "You are Lingora's language coach. Calm, encouraging, low-pressure. Never shame mistakes. " +
  "Respond only with JSON that matches the schema.";

// ---------- shared plumbing ----------

interface Lang { key: string; name: string; isCustom?: boolean }

const uiLang = (data: { uiLanguage?: string }) => String(data.uiLanguage || "en").slice(0, 20);
const inLang = (data: { uiLanguage?: string }) =>
  `Write every explanation, note, title and label in the learner's interface language (BCP-47: ${uiLang(data)}). ` +
  "Only text in the language being learned stays in that language.";

function clip(s: unknown, n = 400): string {
  return String(s ?? "").slice(0, n);
}

async function countUsage(uid: string) {
  const day = new Date().toISOString().slice(0, 10);
  const ref = getFirestore().collection("usage").doc(`${uid}_${day}`);
  const count = await getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const n = ((snap.get("count") as number) ?? 0) + 1;
    tx.set(ref, { count: n, uid, day, at: FieldValue.serverTimestamp() }, { merge: true });
    return n;
  });
  if (count > DAILY_LIMIT.value()) {
    throw new HttpsError("resource-exhausted", "Daily ChatGPT limit reached. It resets tomorrow.");
  }
}

function requireUser(req: CallableRequest<unknown>): string {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in to use ChatGPT features.");
  return uid;
}

function toHttps(e: unknown): HttpsError {
  if (e instanceof HttpsError) return e;
  if (e instanceof chatgpt.PlanError) {
    const kind = e.code === "limit" ? "resource-exhausted" : e.code === "failed" ? "internal" : "failed-precondition";
    return new HttpsError(kind, e.message, { reason: e.code });
  }
  const msg = e instanceof Error ? e.message : String(e);
  console.error("AI call failed", msg);
  return new HttpsError(e instanceof AIError && e.status === 429 ? "resource-exhausted" : "internal", msg);
}

/** A callable that runs on the signed-in user's own ChatGPT plan. */
function callable<I, O>(handler: (data: I, ai: AIClient) => Promise<O>) {
  return onCall({ secrets: SECRETS, timeoutSeconds: 120, memory: "256MiB" }, async (req) => {
    const uid = requireUser(req);
    try {
      requireConfigured();
      const ai = await chatgpt.accessFor(cfg(), uid);
      await countUsage(uid);
      return await handler((req.data ?? {}) as I, ai);
    } catch (e) {
      throw toHttps(e);
    }
  });
}

const langLine = (l: Lang) => `${clip(l.name, 60)}${l.isCustom ? " (a language the learner typed in themselves)" : ""}`;

// ---------- Sign in with ChatGPT ----------

/** Returns the OpenAI authorize URL. Signed-in users link their plan; others sign in with ChatGPT. */
export const chatgptAuthStart = onCall({ secrets: SECRETS }, async (req) => {
  try {
    requireConfigured();
    return { url: await chatgpt.startAuth(cfg(), req.auth?.uid ?? null) };
  } catch (e) {
    throw toHttps(e);
  }
});

/** OpenAI redirects here; we store the encrypted tokens and bounce back into the app. */
export const chatgptCallback = onRequest({ secrets: SECRETS }, async (req, res) => {
  const params = new URLSearchParams(req.query as Record<string, string>);
  const target = await chatgpt.handleCallback(cfg(), params);
  res.redirect(302, target);
});

export const chatgptAuthFinish = onCall(async (req) => chatgpt.finishAuth(clip((req.data as { state?: string })?.state, 80)));

export const chatgptStatus = onCall(async (req) => chatgpt.status(requireUser(req)));

export const chatgptDisconnect = onCall(async (req) => {
  await chatgpt.disconnect(requireUser(req));
  return { connected: false };
});

// ---------- plans ----------

export const weeklyPlan = callable<
  { language: Lang; level: string; goals: string[]; minutesPerDay: number; todayIndex: number; uiLanguage?: string },
  unknown
>(async (d, ai) =>
  complete(ai, {
    name: "weekly_plan",
    schema: obj({
      rationale: str("2 sentences, addressed to the learner, explaining why the week looks like this."),
      days: arr(
        obj({ focus: str("Short focus label, e.g. 'Grammar & writing'."), tasks: arr(taskSchema(false), "1-3 tasks.") }),
        "Exactly 7 days, Monday first.",
      ),
    }),
    system: TONE,
    user:
      `Build a 7-day study plan (Monday first) for ${langLine(d.language)}.\n` +
      `Level: ${clip(d.level, 4)}. Goals: ${(d.goals ?? []).map((g) => clip(g, 40)).join(", ")}.\n` +
      `Time per day for this language: about ${Number(d.minutesPerDay) || 15} minutes in total, split into 1-3 tasks.\n` +
      `Today is day ${(Number(d.todayIndex) || 0) + 1} of the week. Mix ${TASK_TYPES.join(", ")}.\n` +
      `Task titles are short and concrete (e.g. "Ordering tapas in Madrid", "Ser vs. estar").\n${inLang(d)}`,
  }),
);

export const adaptToday = callable<
  {
    languages: { key: string; name: string; level: string; tasks: { type: string; title: string; minutes: number }[] }[];
    recent: { langKey: string; type: string; title: string; score: number }[];
    uiLanguage?: string;
  },
  unknown
>(async (d, ai) =>
  complete(ai, {
    name: "daily_adaptation",
    schema: obj({
      note: str("One or two calm sentences explaining what changed today and why."),
      languages: arr(obj({ key: str("The language key exactly as given."), tasks: arr(taskSchema(true), "1-3 tasks.") })),
    }),
    system: TONE,
    user:
      "Adapt today's tasks to how the learner has been doing. Keep total minutes roughly the same. " +
      "Only change what the results justify; mark changed or added tasks with adapted=true.\nLanguages:\n" +
      (d.languages ?? [])
        .slice(0, 8)
        .map((l) => `- key ${clip(l.key, 40)}: ${clip(l.name, 60)} ${clip(l.level, 4)}. Planned: ` +
          (l.tasks ?? []).map((t) => `${t.type} '${clip(t.title, 80)}' ${t.minutes}m`).join("; "))
        .join("\n") +
      "\nRecent results (score out of 3):\n" +
      ((d.recent ?? []).slice(-12).map((r) => `${clip(r.langKey, 40)} ${r.type} '${clip(r.title, 80)}': ${r.score}/3`).join("\n") || "none yet") +
      `\n${inLang(d)}`,
  }),
);

// ---------- lessons ----------

export const lesson = callable<
  { language: Lang; level: string; task: { type: string; title: string; minutes: number }; uiLanguage?: string },
  unknown
>(async (d, ai) => {
  const name = clip(d.language?.name, 60);
  return complete(ai, {
    name: "lesson",
    schema: obj({
      card: obj({
        front: str(`A word or short phrase in ${name}, native script.`),
        back: str("Its meaning in the learner's interface language."),
        example: str(`A short example sentence in ${name}.`),
      }),
      question: obj({
        prompt: str(`A gap-fill sentence in ${name} with ___ for the gap, or a short question.`),
        options: arr(str("Answer option."), "Exactly 4 options."),
        answer: int("0-based index of the correct option."),
        why: str("One-sentence explanation in the learner's interface language."),
      }),
      writing: obj({
        prompt: str("A short writing task in the learner's interface language, e.g. Translate: “…”."),
        modelAnswer: str(`A natural model answer in ${name}.`),
      }),
    }),
    system: TONE,
    user:
      `Create a 3-step micro-lesson for a ${clip(d.level, 4)} learner of ${langLine(d.language)}.\n` +
      `Task: ${clip(d.task?.type, 20)} — "${clip(d.task?.title, 120)}" (${Number(d.task?.minutes) || 6} min).\n` +
      "Step 1 flashcard, step 2 a 4-option gap fill with exactly one correct answer, step 3 a one-sentence writing task.\n" +
      inLang(d),
  });
});

export const checkWriting = callable<
  { language: Lang; prompt: string; modelAnswer: string; answer: string; uiLanguage?: string },
  unknown
>(async (d, ai) =>
  complete(ai, {
    name: "writing_check",
    schema: obj({
      correct: bool(),
      feedback: str("1-2 kind sentences: what was good, what to fix."),
      modelAnswer: str(`The most natural version in ${clip(d.language?.name, 60)}, ideally close to the learner's wording.`),
    }),
    system: TONE,
    user:
      `Language: ${langLine(d.language)}. Task: ${clip(d.prompt)}\nReference answer: ${clip(d.modelAnswer)}\n` +
      `Learner wrote: ${clip(d.answer) || "(nothing)"}\n${inLang(d)}`,
  }),
);

// ---------- tutor & chat ----------

export const tutorTurn = callable<
  { language: Lang; level: string; scene: string; history: { role: string; text: string }[]; uiLanguage?: string },
  unknown
>(async (d, ai) => {
  const name = clip(d.language?.name, 60);
  const transcript = (d.history ?? [])
    .slice(-20)
    .filter((m) => m.role === "ai" || m.role === "me")
    .map((m) => `${m.role === "ai" ? "Tutor" : "Learner"}: ${clip(m.text, 500)}`)
    .join("\n");
  return complete(ai, {
    name: "tutor_turn",
    schema: obj({
      hasCorrection: bool("True only if the learner's last message has a real mistake."),
      wrong: str("The exact wrong fragment from the learner's last message, or empty."),
      right: str("The corrected fragment, or empty."),
      note: str("One short explanation in the learner's interface language, or empty."),
      reply: str(`Your next in-character line in ${name}, suited to the learner's level.`),
      suggestions: arr(str(`A short reply the learner could send next, in ${name}.`), "Exactly 3."),
    }),
    system: TONE,
    user:
      `Roleplay scene: ${clip(d.scene, 120)}. You play the other person and stay in character in ${name}.\n` +
      `Learner level: ${clip(d.level, 4)}. Keep replies to one or two short sentences.\nConversation so far:\n${transcript}\n${inLang(d)}`,
  });
});

export const correctMessage = callable<{ language: Lang; message: string; uiLanguage?: string }, unknown>(
  async (d, ai) =>
    complete(ai, {
      name: "correction",
      schema: obj({
        hasCorrection: bool(),
        wrong: str("Exact wrong fragment, or empty."),
        right: str("Corrected fragment, or empty."),
        note: str("One short explanation, or empty."),
      }),
      system: TONE,
      user:
        `The learner sent this ${clip(d.language?.name, 60)} message to a friend: "${clip(d.message, 500)}". ` +
        `Point out at most one real mistake. Ignore style and punctuation.\n${inLang(d)}`,
    }),
);

// ---------- German vocabulary ----------

/** Cached translations work for everyone; new ones need a connected ChatGPT plan. */
export const translateWords = onCall({ secrets: SECRETS, timeoutSeconds: 120 }, async (req) => {
  const uid = requireUser(req);
  const d = (req.data ?? {}) as { ids?: string[]; targetLanguage?: string };
  try {
    let ai: AIClient | null = null;
    if (isConfigured()) {
      try {
        ai = await chatgpt.accessFor(cfg(), uid);
      } catch (e) {
        if (!(e instanceof chatgpt.PlanError && e.code === "not-connected")) throw e;
      }
    }
    return await translate((d.ids ?? []).map(String), d.targetLanguage || "en", ai);
  } catch (e) {
    throw toHttps(e);
  }
});

export const checkTranslation = callable<
  { id: string; answer: string; targetLanguage: string; accepted?: string[] },
  unknown
>(async (d, ai) => {
  if (!vocab().has(String(d.id))) throw new HttpsError("invalid-argument", "Unknown word.");
  return checkTr(String(d.id), clip(d.answer, 120), d.targetLanguage || "en", (d.accepted ?? []).map((a) => clip(a, 60)), ai);
});

// ---------- Social: profiles, friends, feed, challenges, chat, devices ----------

type Ctx = { uid: string; email?: string };
/** A signed-in callable that doesn't need ChatGPT. */
function userCall<I>(handler: (data: I, ctx: Ctx) => Promise<unknown>) {
  return onCall({ secrets: SECRETS }, async (req) => {
    const uid = requireUser(req);
    try {
      return await handler((req.data ?? {}) as I, { uid, email: req.auth?.token?.email as string | undefined });
    } catch (e) {
      throw toHttps(e);
    }
  });
}
type Days = { day: string; weekStart: string };

export const profileSync = userCall<{ name?: string; langs?: string[] }>((d, c) => social.syncProfile(c.uid, c.email, d));
export const setHandle = userCall<{ handle: string }>((d, c) => social.setHandle(c.uid, String(d.handle ?? "")));
export const reportActivity = userCall<{ day: string; days?: Record<string, number>; event?: { type: string; params?: Record<string, string> } }>(
  (d, c) => social.reportActivity(c.uid, d));
export const searchUsers = userCall<Days & { query: string }>((d, c) => social.searchUsers(c.uid, String(d.query ?? ""), d.day, d.weekStart));
export const matchContacts = userCall<Days & { hashes: string[] }>((d, c) =>
  social.matchContacts(c.uid, (d.hashes ?? []).map(String), d.day, d.weekStart));
export const sendFriendRequest = userCall<{ uid?: string; handle?: string }>((d, c) => social.sendFriendRequest(c.uid, d));
export const respondFriendRequest = userCall<{ uid: string; accept: boolean }>((d, c) =>
  social.respondFriendRequest(c.uid, String(d.uid ?? ""), !!d.accept));
export const removeFriend = userCall<{ uid: string }>((d, c) => social.removeFriend(c.uid, String(d.uid ?? "")));
export const friendsOverview = userCall<Days>((d, c) => social.overview(c.uid, d.day, d.weekStart));
export const cheer = userCall<{ owner: string; id: string }>((d, c) => social.cheer(c.uid, String(d.owner ?? ""), String(d.id ?? "")));
export const nudge = userCall<{ uid: string; day: string }>((d, c) => social.nudge(c.uid, String(d.uid ?? ""), d.day));
export const markNudgesSeen = userCall<{ ids: string[] }>((d, c) => social.markNudgesSeen(c.uid, (d.ids ?? []).map(String)));
export const createChallenge = userCall<Parameters<typeof social.createChallenge>[1]>((d, c) => social.createChallenge(c.uid, d));
export const respondChallenge = userCall<{ id: string; accept: boolean }>((d, c) =>
  social.respondChallenge(c.uid, String(d.id ?? ""), !!d.accept));
export const leaveChallenge = userCall<{ id: string }>((d, c) => social.leaveChallenge(c.uid, String(d.id ?? "")));
export const sharePlan = userCall<{ lang: string; title: string; plan: string }>((d, c) => social.sharePlan(c.uid, d));
export const getSharedPlan = userCall<{ planId: string }>((d, c) => social.getSharedPlan(c.uid, String(d.planId ?? "")));
export const chatMessages = userCall<{ uid: string }>((d, c) => social.chatMessages(c.uid, String(d.uid ?? "")));
export const sendChatMessage = userCall<{ uid: string; text: string; language?: Lang; uiLanguage?: string }>(async (d, c) => {
  let correct: ((t: string) => Promise<{ wrong: string; right: string; note: string } | null>) | null = null;
  if (isConfigured() && d.language?.name) {
    try {
      const ai = await chatgpt.accessFor(cfg(), c.uid);
      correct = async (t) => {
        const r = (await complete(ai, {
          name: "correction",
          schema: obj({ hasCorrection: bool(), wrong: str("Exact wrong fragment, or empty."), right: str("Corrected fragment, or empty."), note: str("One short explanation, or empty.") }),
          system: TONE,
          user: `The learner sent this ${clip(d.language?.name, 60)} message to a friend: "${clip(t, 500)}". ` +
            `Point out at most one real mistake. Ignore style and punctuation. If the message isn't in ${clip(d.language?.name, 60)}, report no correction.\n${inLang(d)}`,
        })) as { hasCorrection: boolean; wrong: string; right: string; note: string };
        return r.hasCorrection && r.wrong && r.right ? { wrong: r.wrong, right: r.right, note: r.note } : null;
      };
    } catch {
      correct = null; // No ChatGPT plan connected: send without a correction.
    }
  }
  return social.sendChatMessage(c.uid, String(d.uid ?? ""), String(d.text ?? ""), correct);
});
export const registerDevice = userCall<{ id: string; name: string; model: string; os: string }>((d, c) => social.registerDevice(c.uid, d));
export const listDevices = userCall<Record<string, never>>((_d, c) => social.listDevices(c.uid));
export const setPrivacy = userCall<{ shareActivity: boolean }>((d, c) => social.setPrivacy(c.uid, d.shareActivity !== false));
export const setAvatar = userCall<{ image?: string | null }>((d, c) => social.setAvatar(c.uid, d.image ?? null));
export const removeDevice = userCall<{ id: string }>((d, c) => social.removeDevice(c.uid, String(d.id ?? "")));

// ---------- Course units ----------

/**
 * Writes the next course unit (words + sentences; the app builds the exercises). Units are cached per
 * language, level and number, so everyone after the first learner gets them without using their plan.
 */
export const courseUnit = onCall({ secrets: SECRETS, timeoutSeconds: 120 }, async (req) => {
  const uid = requireUser(req);
  const d = (req.data ?? {}) as { language?: Lang; level?: string; index?: number; previous?: string[] };
  const name = clip(d.language?.name, 60);
  const key = clip((d.language as { key?: string } | undefined)?.key, 40).replace(/[^a-zA-Z0-9-]/g, "") || name.toLowerCase();
  const level = /^(A1|A2|B1|B2|C1)$/.test(String(d.level)) ? String(d.level) : "A1";
  const index = Math.max(0, Math.min(200, Math.round(Number(d.index) || 0)));
  if (!name) throw new HttpsError("invalid-argument", "Missing language.");
  const ref = getFirestore().collection("courseUnits").doc(`${key}-${level}-${index}`);
  const cached = await ref.get();
  if (cached.exists) return cached.get("unit");
  try {
    requireConfigured();
    const ai = await chatgpt.accessFor(cfg(), uid);
    await countUsage(uid);
    const item = obj({ t: str(`Text in ${name}. Nouns with their article if the language has them.`), en: str("Meaning in English.") });
    const unit = await complete(ai, {
      name: "course_unit",
      schema: obj({
        title: str("Short English unit title, 2-4 words."),
        tip: str("One short grammar tip in English, with an example in the language."),
        words: arr(item, "Exactly 8 new words or short phrases."),
        sentences: arr(item, "Exactly 6 short sentences using mostly this unit's and earlier words."),
      }),
      system: TONE,
      user: `Write unit ${index + 1} of a ${langLine(d.language as Lang)} course for level ${level}. ` +
        `Earlier units: ${(d.previous ?? []).slice(-30).map((p) => clip(p, 60)).join("; ") || "none"}. ` +
        "Pick the next most useful everyday topic, not repeating earlier ones. Keep sentences short and natural for the level.",
    }) as { title: string; tip: string; words: { t: string; en: string }[]; sentences: { t: string; en: string }[] };
    const out = {
      id: `${key}-${level}-${index}`, title: clip(unit.title, 60), tip: clip(unit.tip, 300),
      words: unit.words.slice(0, 10).map((w) => ({ t: clip(w.t, 80), en: clip(w.en, 80) })),
      sentences: unit.sentences.slice(0, 8).map((w) => ({ t: clip(w.t, 160), en: clip(w.en, 160) })),
    };
    if (out.words.length < 4 || out.sentences.length < 3) throw new HttpsError("internal", "The unit came back too short.");
    await ref.set({ unit: out, createdAt: FieldValue.serverTimestamp() });
    return out;
  } catch (e) {
    throw toHttps(e);
  }
});
