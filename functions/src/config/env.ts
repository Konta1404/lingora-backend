/**
 * Typed runtime configuration.
 *
 * Everything comes from environment variables, so the same code runs on Render (plain env vars),
 * in Docker, and on Firebase Functions (where secrets and `.env.<project>` values are injected as env vars).
 * Values are read lazily because Firebase only exposes secrets once a request is running.
 */
export const REGION = "europe-west1";

export interface ChatGPTConfig {
  clientId: string;
  clientSecret: string;
  /** 32 random bytes, base64: encrypts the users' ChatGPT tokens at rest. */
  encKey: string;
  discoveryUrl: string;
  callbackUrl: string;
  preferredModels: string[];
}

export interface AppConfig {
  port: number;
  dailyAiLimit: number;
  chatgpt: ChatGPTConfig;
}

const env = (key: string, fallback = ""): string => {
  const v = process.env[key];
  return v === undefined || v === "" ? fallback : v;
};

function callbackUrl(): string {
  const explicit = env("CHATGPT_CALLBACK_URL", "auto");
  if (explicit !== "auto") return explicit;
  const project = env("GCLOUD_PROJECT");
  return env("FUNCTIONS_EMULATOR") === "true"
    ? `http://127.0.0.1:5001/${project}/${REGION}/chatgptCallback`
    : `https://${REGION}-${project}.cloudfunctions.net/chatgptCallback`;
}

export function loadConfig(): AppConfig {
  return {
    port: Number(env("PORT")) || 8080,
    dailyAiLimit: Number(env("DAILY_AI_LIMIT")) || 300,
    chatgpt: {
      clientId: env("CHATGPT_CLIENT_ID", "not-set"),
      clientSecret: env("CHATGPT_CLIENT_SECRET"),
      encKey: env("TOKEN_ENC_KEY"),
      discoveryUrl: env("CHATGPT_DISCOVERY_URL", "https://auth.openai.com/.well-known/openid-configuration"),
      callbackUrl: callbackUrl(),
      preferredModels: env("CHATGPT_MODELS", "gpt-5-mini,gpt-5,gpt-6.1-sol").split(",").map((m) => m.trim()).filter(Boolean),
    },
  };
}

/** Sign in with ChatGPT needs a client ID from OpenAI; until then AI features are off. */
export const isChatGPTConfigured = (cfg: ChatGPTConfig = loadConfig().chatgpt) => !!cfg.clientId && cfg.clientId !== "not-set";
