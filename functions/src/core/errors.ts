/**
 * Error model. Services throw these; the transport adapters (Express, Firebase) translate them into
 * the Firebase callable error format: {"error": {"status", "message", "details"}}.
 */
export type ErrorCode =
  | "invalid-argument" | "failed-precondition" | "out-of-range" | "unauthenticated" | "permission-denied"
  | "not-found" | "already-exists" | "aborted" | "resource-exhausted" | "cancelled" | "unimplemented"
  | "unavailable" | "deadline-exceeded" | "internal" | "unknown" | "data-loss";

/** An error that is safe to show to the user, with a callable status code. */
export class AppError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly details?: unknown) {
    super(message);
    this.name = "AppError";
  }
}

export type PlanErrorCode = "not-connected" | "limit" | "not-eligible" | "revoked" | "failed";

/** A problem with the user's own ChatGPT plan (not connected, limit hit, access revoked…). */
export class PlanError extends Error {
  constructor(message: string, readonly code: PlanErrorCode) {
    super(message);
    this.name = "PlanError";
  }
}

/** OpenAI answered with an error that isn't about the user's plan. */
export class AIError extends Error {
  constructor(message: string, readonly status = 500) {
    super(message);
    this.name = "AIError";
  }
}

export const HTTP_STATUS: Record<ErrorCode, number> = {
  "invalid-argument": 400, "failed-precondition": 400, "out-of-range": 400, unauthenticated: 401,
  "permission-denied": 403, "not-found": 404, "already-exists": 409, aborted: 409,
  "resource-exhausted": 429, cancelled: 499, unimplemented: 501, unavailable: 503,
  "deadline-exceeded": 504, internal: 500, unknown: 500, "data-loss": 500,
};

export const STATUS_NAME: Record<ErrorCode, string> = {
  "invalid-argument": "INVALID_ARGUMENT", "failed-precondition": "FAILED_PRECONDITION", "out-of-range": "OUT_OF_RANGE",
  unauthenticated: "UNAUTHENTICATED", "permission-denied": "PERMISSION_DENIED", "not-found": "NOT_FOUND",
  "already-exists": "ALREADY_EXISTS", aborted: "ABORTED", "resource-exhausted": "RESOURCE_EXHAUSTED",
  cancelled: "CANCELLED", unimplemented: "UNIMPLEMENTED", unavailable: "UNAVAILABLE",
  "deadline-exceeded": "DEADLINE_EXCEEDED", internal: "INTERNAL", unknown: "UNKNOWN", "data-loss": "DATA_LOSS",
};

/** Normalises anything thrown by a handler into an AppError. */
export function toAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  if (e instanceof PlanError) {
    const code: ErrorCode = e.code === "limit" ? "resource-exhausted" : e.code === "failed" ? "internal" : "failed-precondition";
    return new AppError(code, e.message, { reason: e.code });
  }
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof AIError && e.status === 429) return new AppError("resource-exhausted", message);
  return new AppError("internal", message);
}

export const notFound = (message: string) => new AppError("not-found", message);
export const invalid = (message: string) => new AppError("invalid-argument", message);
