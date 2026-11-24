/** The shareable https://<backend>/u/<handle> page. Pure HTML rendering; every value is escaped. */
import { WebProfile } from "../profiles/profile.service";

export const escapeHtml = (t: string) => t.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** Strips a handle from a URL down to the allowed characters. */
export const sanitizeHandle = (raw: string) => raw.toLowerCase().replace(/[^a-z0-9._]/g, "").slice(0, 20);

/** "es" → "Spanish"; custom languages arrive as "x-klingon". */
export function languageName(code: string): string {
  if (code.startsWith("x-")) return code.slice(2).replace(/-/g, " ");
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

const stat = (icon: string, value: string | number, label: string) =>
  `<div class="s"><div class="i">${icon}</div><b>${escapeHtml(String(value))}</b><span>${label}</span></div>`;

function profileBody(w: WebProfile): string {
  const first = escapeHtml(w.name.split(" ")[0] || w.name);
  const since = w.joined ? `<p class="m">Learning since ${w.joined.toLocaleDateString("en", { month: "long", year: "numeric" })}</p>` : "";
  const langs = w.langs.length ? `<div class="l">${w.langs.map((l) => `<span>${escapeHtml(languageName(l))}</span>`).join("")}</div>` : "";
  const grid = w.shares
    ? `<div class="g">${stat("🔥", w.streak, "day streak")}${stat("⚡", w.totalXP, "total XP")}${stat("🛡️", w.league ?? "—", "league")}` +
      `${stat("👥", w.friendsCount, "friends")}${stat("📘", w.lessons, "lessons finished")}${stat("🏆", w.bestStreak, "best streak")}</div>` +
      (w.achievements ? `<p class="m">${w.achievements} achievement${w.achievements === 1 ? "" : "s"} unlocked</p>` : "")
    : `<p class="m">${first} keeps their activity private.</p>`;
  return `<div class="a" style="background:oklch(0.58 0.07 ${Math.round(w.hue)})">${escapeHtml((w.name[0] ?? "?").toUpperCase())}</div>
<h1>${escapeHtml(w.name)}</h1><p class="m">@${escapeHtml(w.handle)}</p>${since}${langs}${grid}
<p>${first} wants to practise languages with you.</p>`;
}

const STYLE = `body{font-family:-apple-system,system-ui,sans-serif;background:#f6f1e8;color:#1d1a16;display:grid;place-items:center;min-height:100vh;margin:0}
main{max-width:380px;width:100%;box-sizing:border-box;padding:32px 20px;text-align:center}h1{margin:12px 0 2px;font-size:26px}.m{color:#7a7166;font-size:14px;margin:4px 0}
.a{width:96px;height:96px;border-radius:50%;margin:0 auto;display:grid;place-items:center;color:#fff;font-size:40px;font-weight:700}
.l{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin:12px 0}.l span{background:#e3ecdf;color:#2f5240;font-weight:600;font-size:13px;padding:6px 10px;border-radius:999px}
.g{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:16px 0;text-align:left}.s{background:#fff;border-radius:16px;padding:14px}.s b{display:block;font-size:20px;margin-top:4px}.s span{font-size:12px;color:#7a7166;font-weight:600}
a{display:inline-block;margin-top:16px;padding:14px 22px;border-radius:999px;background:#1d1a16;color:#fff;text-decoration:none;font-weight:600}`;

/** The full page. Without a profile it still offers the invite link. */
export function renderProfilePage(handle: string, w: WebProfile | null): string {
  const deepLink = `lingora://add/${handle}`;
  const body = w ? profileBody(w) : `<h1>Lingora</h1><p>Add @${escapeHtml(handle)} on Lingora.</p>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${w ? escapeHtml(w.name) + " on Lingora" : "Lingora"}</title>
<style>${STYLE}</style>
</head><body><main>${body}
<a href="${deepLink}">Open in Lingora</a><p class="m" style="margin-top:24px">Install Lingora on your iPhone first, then tap the button.</p></main></body></html>`;
}
