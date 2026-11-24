import * as fs from "fs";
import { dataFile } from "../../config/paths";

/** A word from the bundled German list (Goethe-Institut A1–B1). */
export interface VocabWord {
  id: string;
  level: "A1" | "A2" | "B1";
  pos: "noun" | "verb" | "other";
  de: string;
  article?: string;
  plural?: string | null;
  perfekt?: string;
  example?: string;
  exampleEn?: string;
}

let cache: Map<string, VocabWord> | null = null;

export function wordList(): Map<string, VocabWord> {
  if (!cache) {
    const data = JSON.parse(fs.readFileSync(dataFile("vocab_de.json"), "utf8")) as { words: VocabWord[] };
    cache = new Map(data.words.map((w) => [w.id, w]));
  }
  return cache;
}

/** "der Hund", "gehen" */
export const headword = (w: VocabWord) => (w.pos === "noun" ? `${w.article} ${w.de}` : w.de);

/** "sr-Latn-ME" → "sr-Latn", "en-US" → "en": one cache entry per language and script. */
export function normalizeLang(tag: string): string {
  const parts = (tag || "en").replace(/_/g, "-").split("-");
  const lang = parts[0].toLowerCase();
  const script = parts.find((p) => p.length === 4);
  return script ? `${lang}-${script[0].toUpperCase()}${script.slice(1).toLowerCase()}` : lang;
}
