/**
 * Calls OpenAI's Responses API on the user's own ChatGPT plan (Sign in with ChatGPT),
 * with Structured Outputs (strict JSON schema). Plan usage requires store:false and stream:true.
 */
import { PlanError } from "./chatgpt";

export type Schema = Record<string, unknown>;

export class AIError extends Error {
  constructor(message: string, readonly status = 500) {
    super(message);
  }
}

export interface AIClient { token: string; model: string }

export async function complete<T>(ai: AIClient, opts: { name: string; schema: Schema; system: string; user: string }): Promise<T> {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${ai.token}`, "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({
      model: ai.model,
      instructions: opts.system,
      input: [{ role: "user", content: opts.user }],
      text: { format: { type: "json_schema", name: opts.name, strict: true, schema: opts.schema } },
      store: false,
      stream: true,
    }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: string } };
    const code = body.error?.code ?? "";
    if (code === "subscription_sharing_usage_limit_exceeded" || res.status === 429) {
      throw new PlanError("Your ChatGPT plan limit for Lingora is used up for now. Try again later.", "limit");
    }
    if (code === "subscription_sharing_user_not_eligible") {
      throw new PlanError("Using your plan in Lingora needs ChatGPT Plus or Pro.", "not-eligible");
    }
    if (res.status === 401) throw new PlanError("ChatGPT access expired. Connect again.", "revoked");
    throw new AIError(body.error?.message ?? `OpenAI returned ${res.status}`, res.status);
  }

  // Read the server-sent events until response.completed.
  let text = "";
  let finalText = "";
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      const ev = JSON.parse(data) as {
        type: string; delta?: string; message?: string;
        response?: { output?: { content?: { type: string; text?: string; refusal?: string }[] }[]; error?: { message?: string } };
      };
      if (ev.type === "response.output_text.delta" && ev.delta) text += ev.delta;
      if (ev.type === "response.refusal.done") throw new AIError("The model declined this request.", 400);
      if (ev.type === "response.failed" || ev.type === "error") {
        throw new AIError(ev.response?.error?.message ?? ev.message ?? "OpenAI request failed");
      }
      if (ev.type === "response.completed") {
        for (const o of ev.response?.output ?? []) for (const c of o.content ?? []) if (c.type === "output_text") finalText += c.text ?? "";
      }
    }
  }
  const out = finalText || text;
  if (!out) throw new AIError("Empty response from OpenAI");
  return JSON.parse(out) as T;
}

// ---- Schema helpers (strict mode: every property required, no extras) ----

export const obj = (props: Record<string, Schema>): Schema => ({
  type: "object",
  properties: props,
  required: Object.keys(props),
  additionalProperties: false,
});
export const str = (description: string): Schema => ({ type: "string", description });
export const int = (description: string): Schema => ({ type: "integer", description });
export const bool = (description = ""): Schema => ({ type: "boolean", description });
export const arr = (items: Schema, description = ""): Schema => ({ type: "array", items, description });

export const TASK_TYPES = ["vocabulary", "listening", "speaking", "reading", "writing", "grammar", "roleplay"];
export const taskSchema = (adapted: boolean): Schema =>
  obj({
    type: { type: "string", enum: TASK_TYPES },
    title: str("Short task title, written in the learner's interface language."),
    minutes: int("Minutes, 4-15."),
    ...(adapted ? { adapted: bool("True if this task was changed or added today.") } : {}),
  });
