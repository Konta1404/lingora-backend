/** Access to the caller's own ChatGPT plan, in the three flavours the API needs. */
import { isChatGPTConfigured, loadConfig } from "../../config/env";
import { AppError, PlanError } from "../../core/errors";
import { AIClient } from "../../infra/openai/client";
import { accessFor } from "../chatgpt/tokens";
import { countUsage } from "./usage";

export function requireChatGPTConfigured(): void {
  if (!isChatGPTConfigured()) {
    throw new AppError("failed-precondition", "Sign in with ChatGPT isn't set up yet. It needs a client ID from OpenAI.", {
      reason: "not-configured",
    });
  }
}

/** The user's plan, for a call that needs AI. Counts the call against the daily cap. */
export async function planFor(uid: string): Promise<AIClient> {
  requireChatGPTConfigured();
  const ai = await accessFor(loadConfig().chatgpt, uid);
  await countUsage(uid);
  return ai;
}

/** The user's plan if one is connected, else null. Other plan problems still throw. Not counted. */
export async function optionalPlan(uid: string): Promise<AIClient | null> {
  if (!isChatGPTConfigured()) return null;
  try {
    return await accessFor(loadConfig().chatgpt, uid);
  } catch (e) {
    if (e instanceof PlanError && e.code === "not-connected") return null;
    throw e;
  }
}

/** The user's plan, or null on any problem (for optional extras like chat corrections). Not counted. */
export async function bestEffortPlan(uid: string): Promise<AIClient | null> {
  return optionalPlan(uid).catch(() => null);
}
