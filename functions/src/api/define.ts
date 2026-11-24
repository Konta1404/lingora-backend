import { AppError } from "../core/errors";
import { CallContext, UserContext } from "../core/context";

/**
 * A transport-independent callable: plain input in, JSON-able result out. The Express server and the
 * Firebase Functions entry point both serve the same definitions, so the API lives in exactly one place.
 */
export interface CallableDef {
  /** "user": a signed-in Firebase user is required. "public": anyone (the handler gets uid null). */
  access: "user" | "public";
  /** Firebase-only runtime hints. */
  timeoutSeconds?: number;
  memory?: "256MiB" | "512MiB";
  handle(data: Record<string, unknown>, ctx: CallContext): Promise<unknown>;
}

/** The input as sent by the client: an object of unknown fields. */
export type Input = Record<string, unknown>;

export function requireUser(ctx: CallContext): UserContext {
  if (!ctx.uid) throw new AppError("unauthenticated", "Sign in to use ChatGPT features.");
  return { uid: ctx.uid, email: ctx.email };
}

/** A callable for signed-in users. */
export function userCallable<I = Input>(
  handler: (data: I, user: UserContext) => Promise<unknown>,
  opts: Pick<CallableDef, "timeoutSeconds" | "memory"> = {},
): CallableDef {
  return { access: "user", ...opts, handle: async (data, ctx) => handler(data as I, requireUser(ctx)) };
}

/** A callable anyone may call (e.g. the start of a sign-in). */
export function publicCallable<I = Input>(handler: (data: I, ctx: CallContext) => Promise<unknown>): CallableDef {
  return { access: "public", handle: async (data, ctx) => handler(data as I, ctx) };
}

/** Runs a callable: input normalisation happens here so every adapter behaves the same. */
export async function invoke(def: CallableDef, data: unknown, ctx: CallContext): Promise<unknown> {
  const input = data && typeof data === "object" && !Array.isArray(data) ? (data as Input) : {};
  return def.handle(input, ctx);
}
