/**
 * Course units written by AI: words + sentences (the app builds the exercises). Units are cached per
 * language and topic (or level and number), so only the first learner to reach one uses their plan.
 */
import { FieldValue } from "firebase-admin/firestore";
import { userCallable } from "../../api/define";
import { AppError } from "../../core/errors";
import { truncate, clampInt } from "../../core/text";
import { col } from "../../infra/collections";
import { complete } from "../../infra/openai/client";
import { obj, str, arr } from "../../infra/openai/schema";
import { planFor } from "../ai/plan";
import { TONE, langLine, Lang } from "../ai/prompts";

const LEVELS = /^(A1|A2|B1|B2|C1|C2)$/;

interface Item { t: string; en: string }
export interface CourseUnit { id: string; title: string; tip: string; topic: string | null; words: Item[]; sentences: Item[] }

export interface UnitRequest {
  language?: Lang;
  level?: string;
  index?: number;
  previous?: string[];
  topic?: string;
  topicId?: string;
}

/** Normalised request plus the cache id it maps to. */
export function unitKey(d: UnitRequest) {
  const name = truncate(d.language?.name, 60);
  const key = truncate(d.language?.key, 40).replace(/[^a-zA-Z0-9-]/g, "") || name.toLowerCase();
  const level = LEVELS.test(String(d.level)) ? String(d.level) : "A1";
  const topicId = truncate(d.topicId, 60).replace(/[^a-z0-9-]/g, "");
  const index = clampInt(d.index, 0, 200);
  return { name, key, level, topicId, index, topic: truncate(d.topic, 120), id: topicId ? `${key}-${topicId}` : `${key}-${level}-${index}` };
}

/** Trims what the model wrote to the stored shape; rejects units that came back too thin. */
export function shapeUnit(id: string, topicId: string, raw: { title: string; tip: string; words: Item[]; sentences: Item[] }): CourseUnit {
  const out: CourseUnit = {
    id,
    title: truncate(raw.title, 60),
    tip: truncate(raw.tip, 300),
    topic: topicId || null,
    words: (raw.words ?? []).slice(0, 10).map((w) => ({ t: truncate(w.t, 80), en: truncate(w.en, 80) })),
    sentences: (raw.sentences ?? []).slice(0, 8).map((w) => ({ t: truncate(w.t, 160), en: truncate(w.en, 160) })),
  };
  if (out.words.length < 4 || out.sentences.length < 3) throw new AppError("internal", "The unit came back too short.");
  return out;
}

export const courseUnit = userCallable<UnitRequest>(async (d, u) => {
  const k = unitKey(d);
  if (!k.name) throw new AppError("invalid-argument", "Missing language.");
  const ref = col.courseUnits().doc(k.id);
  const cached = await ref.get();
  if (cached.exists) return cached.get("unit");

  const ai = await planFor(u.uid);
  const language = d.language as Lang;
  const item = obj({ t: str(`Text in ${k.name}. Nouns with their article if the language has them.`), en: str("Meaning in English.") });
  const raw = await complete<{ title: string; tip: string; words: Item[]; sentences: Item[] }>(ai, {
    name: "course_unit",
    schema: obj({
      title: str("Short English unit title, 2-4 words."),
      tip: str("One short grammar tip in English, with an example in the language."),
      words: arr(item, "Exactly 8 new words or short phrases."),
      sentences: arr(item, "Exactly 6 short sentences using mostly this unit's and earlier words."),
    }),
    system: TONE,
    user: k.topic
      ? `Write a ${langLine(language)} course unit on the topic "${k.topic}" for CEFR level ${k.level}. ` +
        "Choose the most useful words and sentences for that topic at that level; sentences short and natural for the level, harder words for higher levels."
      : `Write unit ${k.index + 1} of a ${langLine(language)} course for level ${k.level}. ` +
        `Earlier units: ${(d.previous ?? []).slice(-30).map((p) => truncate(p, 60)).join("; ") || "none"}. ` +
        "Pick the next most useful everyday topic, not repeating earlier ones. Keep sentences short and natural for the level.",
  });
  const unit = shapeUnit(k.id, k.topicId, raw);
  await ref.set({ unit, createdAt: FieldValue.serverTimestamp() });
  return unit;
}, { timeoutSeconds: 120 });
