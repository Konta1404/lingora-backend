/**
 * The Firebase "callable" wire protocol, so the iOS Functions SDK can talk to this server unchanged:
 *   POST /<name>  {"data": …}  Authorization: Bearer <Firebase ID token>
 *   → 200 {"result": …}  or  4xx/5xx {"error": {"status", "message", "details"}}
 */
import { AppError, HTTP_STATUS, STATUS_NAME } from "../core/errors";

/**
 * The Firebase client SDKs send 64-bit integers as {"@type": ".../google.protobuf.Int64Value", "value": "21"}.
 * Firebase's own runtime unwraps them; this server has to do it itself.
 */
export function decodeCallable(v: unknown): unknown {
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

export function errorBody(err: AppError) {
  return {
    status: HTTP_STATUS[err.code] ?? 500,
    body: { error: { status: STATUS_NAME[err.code] ?? "INTERNAL", message: err.message, details: err.details } },
  };
}
