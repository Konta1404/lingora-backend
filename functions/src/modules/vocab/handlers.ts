import { userCallable } from "../../api/define";
import { AppError } from "../../core/errors";
import { truncate, strings } from "../../core/text";
import { aiCallable } from "../ai/handlers";
import { optionalPlan } from "../ai/plan";
import { checkTranslation as check, translateWords as translate } from "./vocab.service";
import { wordList } from "./word-list";

/** Cached translations work for everyone; new ones need a connected ChatGPT plan. */
export const translateWords = userCallable<{ ids?: unknown; targetLanguage?: string }>(
  async (d, u) => translate(strings(d.ids), d.targetLanguage || "en", await optionalPlan(u.uid)),
  { timeoutSeconds: 120 },
);

export const checkTranslation = aiCallable<{ id: string; answer: string; targetLanguage: string; accepted?: string[] }>(async (d, ai) => {
  if (!wordList().has(String(d.id))) throw new AppError("invalid-argument", "Unknown word.");
  return check(String(d.id), truncate(d.answer, 120), d.targetLanguage || "en", (d.accepted ?? []).map((a) => truncate(a, 60)), ai);
});
