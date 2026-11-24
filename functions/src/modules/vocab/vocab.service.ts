import { FieldValue } from "firebase-admin/firestore";
import { col } from "../../infra/collections";
import { db } from "../../infra/firebase";
import { complete, AIClient } from "../../infra/openai/client";
import { obj, str, arr, bool } from "../../infra/openai/schema";
import { wordList, headword, normalizeLang, VocabWord } from "./word-list";

const MAX_WORDS = 40;

const describe = (w: VocabWord) => `${w.id} | ${headword(w)} (${w.pos})${w.example ? ` | e.g. "${w.example}"` : ""}`;

/**
 * Accepted translations for each word id in the target language. Reads the shared cache
 * (vocabTranslations/{lang}/words) first and, with a connected plan, translates the rest in one call.
 */
export async function translateWords(ids: string[], lang: string, ai: AIClient | null) {
  const target = normalizeLang(lang);
  const words = ids.map((id) => wordList().get(id)).filter((w): w is VocabWord => !!w).slice(0, MAX_WORDS);
  const cacheCol = col.vocabTranslations(target);
  const out: Record<string, string[]> = {};
  if (words.length === 0) return { language: target, translations: out };

  const snaps = await db().getAll(...words.map((w) => cacheCol.doc(w.id)));
  const missing: VocabWord[] = [];
  snaps.forEach((s, i) => {
    const t = s.get("t") as string[] | undefined;
    if (t?.length) out[words[i].id] = t;
    else missing.push(words[i]);
  });
  if (missing.length === 0 || !ai) return { language: target, translations: out };

  const result = await complete<{ items: { id: string; translations: string[] }[] }>(ai, {
    name: "vocab_translations",
    schema: obj({
      items: arr(
        obj({
          id: str("The word id exactly as given."),
          translations: arr(str("A translation."), "1-4 common translations, most common first, lowercase unless a proper noun, no articles."),
        }),
      ),
    }),
    system:
      "You translate German learner vocabulary (Goethe-Institut A1-B1 lists) for a language-learning app. " +
      "Give the everyday meanings a learner at this level needs, matching the example sentence when one is given. " +
      "Translate verbs as infinitives. Respond only with JSON that matches the schema.",
    user: `Target language (BCP-47): ${target}\nWords:\n${missing.map(describe).join("\n")}`,
  });
  const batch = db().batch();
  for (const item of result.items) {
    if (!wordList().has(item.id) || !item.translations?.length) continue;
    const t = item.translations.map((x) => x.trim()).filter(Boolean).slice(0, 4);
    out[item.id] = t;
    batch.set(cacheCol.doc(item.id), { t, at: FieldValue.serverTimestamp() });
  }
  await batch.commit();
  return { language: target, translations: out };
}

export async function checkTranslation(id: string, answer: string, lang: string, accepted: string[], ai: AIClient) {
  const w = wordList().get(id);
  if (!w) return { correct: false, note: "" };
  return complete<{ correct: boolean; note: string }>(ai, {
    name: "translation_check",
    schema: obj({
      correct: bool("True if the learner's answer is an acceptable translation of the German word (synonyms and small typos are fine)."),
      note: str("One short sentence in the target language. Empty when correct."),
    }),
    system: "You check vocabulary answers in a language-learning app. Be fair and encouraging. Respond only with JSON.",
    user:
      `German: ${headword(w)}${w.example ? ` (example: "${w.example}")` : ""}\n` +
      `Target language: ${normalizeLang(lang)}\nKnown translations: ${accepted.join(", ") || "(none)"}\nLearner answered: "${answer}"`,
  });
}
