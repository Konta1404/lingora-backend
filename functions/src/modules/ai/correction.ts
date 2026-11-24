import { complete, AIClient } from "../../infra/openai/client";
import { obj, str, bool } from "../../infra/openai/schema";
import { truncate } from "../../core/text";
import { TONE, inLang, Lang } from "./prompts";

export interface Correction {
  wrong: string;
  right: string;
  note: string;
}

export const correctionSchema = obj({
  hasCorrection: bool(),
  wrong: str("Exact wrong fragment, or empty."),
  right: str("Corrected fragment, or empty."),
  note: str("One short explanation, or empty."),
});

export type CorrectionResult = Correction & { hasCorrection: boolean };

/** At most one real mistake in a message the learner wrote to a friend. */
export function correctMessageText(
  ai: AIClient,
  language: Lang | undefined,
  message: string,
  ui: { uiLanguage?: unknown },
  opts: { strictLanguage?: boolean } = {},
): Promise<CorrectionResult> {
  const name = truncate(language?.name, 60);
  return complete<CorrectionResult>(ai, {
    name: "correction",
    schema: correctionSchema,
    system: TONE,
    user:
      `The learner sent this ${name} message to a friend: "${truncate(message, 500)}". ` +
      "Point out at most one real mistake. Ignore style and punctuation." +
      (opts.strictLanguage ? ` If the message isn't in ${name}, report no correction.` : "") +
      `\n${inLang(ui)}`,
  });
}
