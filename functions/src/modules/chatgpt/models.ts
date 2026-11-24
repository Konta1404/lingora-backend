import { RESOURCE } from "./oidc";

/** Model ids the user's plan can use. Empty when the list can't be read. */
export async function listModels(token: string): Promise<string[]> {
  try {
    const res = await fetch(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: { id: string }[] };
    return (json.data ?? []).map((m) => m.id);
  } catch {
    return [];
  }
}

/** First preferred model the plan offers, else any text GPT model, else the first preference. */
export function pickModel(available: string[], preferred: string[]): string {
  for (const p of preferred) if (available.includes(p)) return p;
  return available.find((m) => /^gpt-/.test(m) && !/(audio|realtime|transcribe|tts|image|search)/.test(m)) ?? preferred[0];
}
