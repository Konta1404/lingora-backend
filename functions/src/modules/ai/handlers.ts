/**
 * AI callables. Each runs on the caller's own ChatGPT plan (see plan.ts) and returns the model's
 * structured JSON as-is; the schemas are the contract with the app.
 */
import { CallableDef, userCallable } from "../../api/define";
import { truncate } from "../../core/text";
import { complete, AIClient } from "../../infra/openai/client";
import { obj, str, arr, bool, int, Schema } from "../../infra/openai/schema";
import { correctMessageText } from "./correction";
import { planFor } from "./plan";
import { TONE, inLang, langLine, langName, transcript, Lang, Turn } from "./prompts";

/** A callable that needs the user's ChatGPT plan. */
export function aiCallable<I>(handler: (data: I, ai: AIClient) => Promise<unknown>): CallableDef {
  return userCallable<I>(async (d, u) => handler(d, await planFor(u.uid)), { timeoutSeconds: 120, memory: "256MiB" });
}

export const TASK_TYPES = ["vocabulary", "listening", "speaking", "reading", "writing", "grammar", "roleplay"];

export const taskSchema = (adapted: boolean): Schema =>
  obj({
    type: { type: "string", enum: TASK_TYPES },
    title: str("Short task title, written in the learner's interface language."),
    minutes: int("Minutes, 4-15."),
    ...(adapted ? { adapted: bool("True if this task was changed or added today.") } : {}),
  });

interface UI {
  uiLanguage?: string;
}

// ---------- Plans ----------

export const weeklyPlan = aiCallable<UI & { language: Lang; level: string; goals: string[]; minutesPerDay: number; todayIndex: number }>(
  (d, ai) =>
    complete(ai, {
      name: "weekly_plan",
      schema: obj({
        rationale: str("2 sentences, addressed to the learner, explaining why the week looks like this."),
        days: arr(
          obj({ focus: str("Short focus label, e.g. 'Grammar & writing'."), tasks: arr(taskSchema(false), "1-3 tasks.") }),
          "Exactly 7 days, Monday first.",
        ),
      }),
      system: TONE,
      user:
        `Build a 7-day study plan (Monday first) for ${langLine(d.language)}.\n` +
        `Level: ${truncate(d.level, 4)}. Goals: ${(d.goals ?? []).map((g) => truncate(g, 40)).join(", ")}.\n` +
        `Time per day for this language: about ${Number(d.minutesPerDay) || 15} minutes in total, split into 1-3 tasks.\n` +
        `Today is day ${(Number(d.todayIndex) || 0) + 1} of the week. Mix ${TASK_TYPES.join(", ")}.\n` +
        `Task titles are short and concrete (e.g. "Ordering tapas in Madrid", "Ser vs. estar").\n${inLang(d)}`,
    }),
);

export const adaptToday = aiCallable<UI & {
  languages: { key: string; name: string; level: string; tasks: { type: string; title: string; minutes: number }[] }[];
  recent: { langKey: string; type: string; title: string; score: number }[];
}>((d, ai) =>
  complete(ai, {
    name: "daily_adaptation",
    schema: obj({
      note: str("One or two calm sentences explaining what changed today and why."),
      languages: arr(obj({ key: str("The language key exactly as given."), tasks: arr(taskSchema(true), "1-3 tasks.") })),
    }),
    system: TONE,
    user:
      "Adapt today's tasks to how the learner has been doing. Keep total minutes roughly the same. " +
      "Only change what the results justify; mark changed or added tasks with adapted=true.\nLanguages:\n" +
      (d.languages ?? [])
        .slice(0, 8)
        .map((l) => `- key ${truncate(l.key, 40)}: ${truncate(l.name, 60)} ${truncate(l.level, 4)}. Planned: ` +
          (l.tasks ?? []).map((t) => `${t.type} '${truncate(t.title, 80)}' ${t.minutes}m`).join("; "))
        .join("\n") +
      "\nRecent results (score out of 3):\n" +
      ((d.recent ?? []).slice(-12).map((r) => `${truncate(r.langKey, 40)} ${r.type} '${truncate(r.title, 80)}': ${r.score}/3`).join("\n") || "none yet") +
      `\n${inLang(d)}`,
  }),
);

// ---------- Lessons ----------

export const lesson = aiCallable<UI & { language: Lang; level: string; task: { type: string; title: string; minutes: number } }>((d, ai) => {
  const name = langName(d.language);
  return complete(ai, {
    name: "lesson",
    schema: obj({
      card: obj({
        front: str(`A word or short phrase in ${name}, native script.`),
        back: str("Its meaning in the learner's interface language."),
        example: str(`A short example sentence in ${name}.`),
      }),
      question: obj({
        prompt: str(`A gap-fill sentence in ${name} with ___ for the gap, or a short question.`),
        options: arr(str("Answer option."), "Exactly 4 options."),
        answer: int("0-based index of the correct option."),
        why: str("One-sentence explanation in the learner's interface language."),
      }),
      writing: obj({
        prompt: str("A short writing task in the learner's interface language, e.g. Translate: “…”."),
        modelAnswer: str(`A natural model answer in ${name}.`),
      }),
    }),
    system: TONE,
    user:
      `Create a 3-step micro-lesson for a ${truncate(d.level, 4)} learner of ${langLine(d.language)}.\n` +
      `Task: ${truncate(d.task?.type, 20)} — "${truncate(d.task?.title, 120)}" (${Number(d.task?.minutes) || 6} min).\n` +
      "Step 1 flashcard, step 2 a 4-option gap fill with exactly one correct answer, step 3 a one-sentence writing task.\n" +
      inLang(d),
  });
});

export const checkWriting = aiCallable<UI & { language: Lang; prompt: string; modelAnswer: string; answer: string }>((d, ai) =>
  complete(ai, {
    name: "writing_check",
    schema: obj({
      correct: bool(),
      feedback: str("1-2 kind sentences: what was good, what to fix."),
      modelAnswer: str(`The most natural version in ${langName(d.language)}, ideally close to the learner's wording.`),
    }),
    system: TONE,
    user:
      `Language: ${langLine(d.language)}. Task: ${truncate(d.prompt)}\nReference answer: ${truncate(d.modelAnswer)}\n` +
      `Learner wrote: ${truncate(d.answer) || "(nothing)"}\n${inLang(d)}`,
  }),
);

export const explainAnswer = aiCallable<UI & { language: Lang; task: string; prompt: string; expected: string; answer: string }>((d, ai) =>
  complete(ai, {
    name: "explanation",
    schema: obj({ explanation: str("Two or three short sentences: why the expected answer is right and what was wrong in the learner's answer.") }),
    system: TONE,
    user:
      `A learner of ${langLine(d.language)} did this exercise: ${truncate(d.task, 120)}.\nPrompt: ${truncate(d.prompt, 300)}\n` +
      `Expected answer: ${truncate(d.expected, 300)}\nLearner's answer: ${truncate(d.answer, 300) || "(none)"}\n` +
      `Explain simply, mention the grammar rule if there is one.\n${inLang(d)}`,
  }),
);

// ---------- Tutor, calls and corrections ----------

export const tutorTurn = aiCallable<UI & { language: Lang; level: string; scene: string; history: Turn[]; memory?: string[] }>((d, ai) => {
  const name = langName(d.language);
  const memory = d.memory ?? [];
  return complete(ai, {
    name: "tutor_turn",
    schema: obj({
      hasCorrection: bool("True only if the learner's last message has a real mistake."),
      wrong: str("The exact wrong fragment from the learner's last message, or empty."),
      right: str("The corrected fragment, or empty."),
      note: str("One short explanation in the learner's interface language, or empty."),
      reply: str(`Your next in-character line in ${name}, suited to the learner's level.`),
      suggestions: arr(str(`A short reply the learner could send next, in ${name}.`), "Exactly 3."),
      remember: str("A short new fact about the learner from their last message worth remembering next time (name, job, family, hobby, plans), in English, or empty."),
    }),
    system: TONE,
    user:
      `Roleplay scene: ${truncate(d.scene, 120)}. You play the other person and stay in character in ${name}.\n` +
      (memory.length
        ? `What you remember about the learner from earlier chats: ${memory.slice(-15).map((m) => truncate(m, 120)).join("; ")}. Use it naturally when it fits.\n`
        : "") +
      `Learner level: ${truncate(d.level, 4)}. Keep replies to one or two short sentences.\n` +
      `Conversation so far:\n${transcript(d.history, 20, 500)}\n${inLang(d)}`,
  });
});

export const callFeedback = aiCallable<UI & { language: Lang; level: string; history: Turn[] }>((d, ai) =>
  complete(ai, {
    name: "call_feedback",
    schema: obj({
      summary: str("One or two encouraging sentences about how the learner did."),
      strengths: arr(str("Something the learner did well."), "One to three."),
      fixes: arr(obj({ wrong: str("Exact wrong phrase."), right: str("Corrected phrase."), note: str("Short explanation.") }), "Up to three most useful corrections."),
    }),
    system: TONE,
    user: `Spoken practice call in ${langLine(d.language)}, learner level ${truncate(d.level, 4)}.\nTranscript:\n${transcript(d.history, 40, 400)}\n${inLang(d)}`,
  }),
);

export const correctMessage = aiCallable<UI & { language: Lang; message: string }>((d, ai) =>
  correctMessageText(ai, d.language, d.message, d),
);
