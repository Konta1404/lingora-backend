import { truncate } from "../../core/text";

/** The learner's language as sent by the app. */
export interface Lang {
  key?: string;
  name: string;
  isCustom?: boolean;
}

export const TONE =
  "You are Lingora's language coach. Calm, encouraging, low-pressure. Never shame mistakes. " +
  "Respond only with JSON that matches the schema.";

export const uiLang = (d: { uiLanguage?: unknown }) => String(d.uiLanguage || "en").slice(0, 20);

/** Keeps explanations in the learner's interface language. */
export const inLang = (d: { uiLanguage?: unknown }) =>
  `Write every explanation, note, title and label in the learner's interface language (BCP-47: ${uiLang(d)}). ` +
  "Only text in the language being learned stays in that language.";

export const langName = (l: Lang | undefined) => truncate(l?.name, 60);

export const langLine = (l: Lang | undefined) =>
  `${truncate(l?.name, 60)}${l?.isCustom ? " (a language the learner typed in themselves)" : ""}`;

export interface Turn {
  role: string;
  text: string;
}

/** A chat transcript for the prompt: the last `keep` turns, as "Tutor:" / "Learner:" lines. */
export function transcript(history: Turn[] | undefined, keep: number, perTurn: number): string {
  return (history ?? [])
    .slice(-keep)
    .filter((m) => m.role === "ai" || m.role === "me")
    .map((m) => `${m.role === "ai" ? "Tutor" : "Learner"}: ${truncate(m.text, perTurn)}`)
    .join("\n");
}
