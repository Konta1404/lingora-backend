import { loadConfig } from "../../config/env";
import { truncate } from "../../core/text";
import { publicCallable, userCallable } from "../../api/define";
import { requireChatGPTConfigured } from "../ai/plan";
import { startAuth, finishAuth } from "./auth-flow";
import * as tokens from "./tokens";

/** Returns the OpenAI authorize URL. Signed-in users link their plan; others sign in with ChatGPT. */
export const chatgptAuthStart = publicCallable(async (_d, ctx) => {
  requireChatGPTConfigured();
  return { url: await startAuth(loadConfig().chatgpt, ctx.uid) };
});

export const chatgptAuthFinish = publicCallable<{ state?: unknown }>(async (d) => finishAuth(truncate(d.state, 80)));

export const chatgptStatus = userCallable(async (_d, u) => tokens.status(u.uid));

export const chatgptDisconnect = userCallable(async (_d, u) => {
  await tokens.disconnect(u.uid);
  return { connected: false };
});
