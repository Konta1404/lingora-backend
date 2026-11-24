/**
 * Firebase Cloud Functions (2nd gen) entry point: serves the same API as server.ts, for `firebase deploy`
 * and the local emulator (scripts/dev.sh). Each callable in api/registry.ts becomes one function.
 *
 * Secrets: firebase functions:secrets:set CHATGPT_CLIENT_SECRET / TOKEN_ENC_KEY.
 * Plain params (CHATGPT_CLIENT_ID, CHATGPT_MODELS, …) go in functions/.env.<project-id>.
 */
import { setGlobalOptions } from "firebase-functions/v2";
import { onCall, onRequest, HttpsError, CallableFunction } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { CallableDef, invoke } from "./api/define";
import { callables, CallableName } from "./api/registry";
import { REGION, loadConfig } from "./config/env";
import { toAppError } from "./core/errors";
import { logger } from "./core/logger";
import { initFirebase } from "./infra/firebase";
import { handleCallback } from "./modules/chatgpt/auth-flow";

initFirebase();
setGlobalOptions({ region: REGION, maxInstances: 10 });

const SECRETS = [defineSecret("CHATGPT_CLIENT_SECRET"), defineSecret("TOKEN_ENC_KEY")];

function toFirebase(name: string, def: CallableDef) {
  return onCall({ secrets: SECRETS, timeoutSeconds: def.timeoutSeconds, memory: def.memory }, async (req) => {
    try {
      const email = req.auth?.token?.email;
      return await invoke(def, req.data, { uid: req.auth?.uid ?? null, email: typeof email === "string" ? email : undefined });
    } catch (e) {
      const err = toAppError(e);
      if (err.code === "internal") logger.error(`${name} failed`, { error: e });
      throw new HttpsError(err.code, err.message, err.details);
    }
  });
}

type Exported = Record<CallableName, CallableFunction<unknown, Promise<unknown>>>;
const fns = Object.fromEntries(Object.entries(callables).map(([name, def]) => [name, toFirebase(name, def)])) as Exported;

export const {
  weeklyPlan, adaptToday, lesson, checkWriting, tutorTurn, correctMessage, explainAnswer, callFeedback, courseUnit,
  translateWords, checkTranslation, chatgptAuthStart, chatgptAuthFinish, chatgptStatus, chatgptDisconnect,
  profileSync, setHandle, setPrivacy, setAvatar, publicProfile, reportActivity, leagueStatus, sendFeedback,
  searchUsers, matchContacts, sendFriendRequest, respondFriendRequest, removeFriend, friendsOverview, cheer, nudge,
  markNudgesSeen, createChallenge, respondChallenge, leaveChallenge, sharePlan, getSharedPlan, chatMessages,
  sendChatMessage, registerDevice, listDevices, removeDevice,
} = fns;

/** OpenAI redirects here after Sign in with ChatGPT. */
export const chatgptCallback = onRequest({ secrets: SECRETS }, async (req, res) => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query)) if (typeof v === "string") params.set(k, v);
  res.redirect(302, await handleCallback(loadConfig().chatgpt, params));
});
