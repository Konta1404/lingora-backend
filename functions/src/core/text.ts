/** Input sanitising helpers. Clients are untrusted: every string is coerced and length-limited. */

/** String(value), trimmed and cut to n characters. */
export function clip(value: unknown, n: number): string {
  return String(value ?? "").trim().slice(0, n);
}

/** String(value) cut to n characters, whitespace kept (used for text that goes into AI prompts). */
export function truncate(value: unknown, n = 400): string {
  return String(value ?? "").slice(0, n);
}

/** A whole number clamped to [min, max]; NaN becomes `fallback` (then clamped). */
export function clampInt(value: unknown, min: number, max: number, fallback = 0): number {
  const n = Math.round(Number(value));
  return Math.max(min, Math.min(max, Number.isFinite(n) ? n : fallback));
}

export const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);
