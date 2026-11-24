/**
 * OpenAI Responses API on the user's own ChatGPT plan (Sign in with ChatGPT), with Structured Outputs.
 * Plan usage requires store:false and stream:true, so the answer is assembled from server-sent events.
 */
import { AIError, PlanError } from "../../core/errors";
import { Schema } from "./schema";
import { sseEvents } from "./sse";

const RESPONSES_URL = "https://api.openai.com/v1/responses";

/** A user's access token and the model picked for their plan. */
export interface AIClient {
  token: string;
  model: string;
}

export interface CompletionRequest {
  name: string;
  schema: Schema;
  system: string;
  user: string;
}

interface StreamEvent {
  type: string;
  delta?: string;
  message?: string;
  response?: { output?: { content?: { type: string; text?: string }[] }[]; error?: { message?: string } };
}

/** Maps an OpenAI error response to a plan problem the app can explain, or a generic AI error. */
export function upstreamError(status: number, body: { error?: { message?: string; code?: string } }): Error {
  const code = body.error?.code ?? "";
  if (code === "subscription_sharing_usage_limit_exceeded" || status === 429) {
    return new PlanError("Your ChatGPT plan limit for Lingora is used up for now. Try again later.", "limit");
  }
  if (code === "subscription_sharing_user_not_eligible") {
    return new PlanError("Using your plan in Lingora needs ChatGPT Plus or Pro.", "not-eligible");
  }
  if (status === 401) return new PlanError("ChatGPT access expired. Connect again.", "revoked");
  return new AIError(body.error?.message ?? `OpenAI returned ${status}`, status);
}

/** Folds the event stream into the final JSON text. */
export async function collectOutput(events: AsyncIterable<unknown>): Promise<string> {
  let deltas = "";
  let final = "";
  for await (const raw of events) {
    const ev = raw as StreamEvent;
    if (ev.type === "response.output_text.delta" && ev.delta) deltas += ev.delta;
    if (ev.type === "response.refusal.done") throw new AIError("The model declined this request.", 400);
    if (ev.type === "response.failed" || ev.type === "error") {
      throw new AIError(ev.response?.error?.message ?? ev.message ?? "OpenAI request failed");
    }
    if (ev.type === "response.completed") {
      for (const o of ev.response?.output ?? []) for (const c of o.content ?? []) if (c.type === "output_text") final += c.text ?? "";
    }
  }
  return final || deltas;
}

export async function complete<T>(ai: AIClient, req: CompletionRequest): Promise<T> {
  const res = await fetch(RESPONSES_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${ai.token}`, "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({
      model: ai.model,
      instructions: req.system,
      input: [{ role: "user", content: req.user }],
      text: { format: { type: "json_schema", name: req.name, strict: true, schema: req.schema } },
      store: false,
      stream: true,
    }),
  });
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: string } };
    throw upstreamError(res.status, body);
  }
  const out = await collectOutput(sseEvents(res.body));
  if (!out) throw new AIError("Empty response from OpenAI");
  return JSON.parse(out) as T;
}
