/**
 * Lingora backend as a plain Node web server (Render, Docker, any Node host).
 * Firebase Auth and Firestore stay in Firebase; the API speaks the Firebase callable protocol.
 *
 * Env: FIREBASE_SERVICE_ACCOUNT (service-account JSON), TOKEN_ENC_KEY, CHATGPT_* (see config/env.ts), PORT.
 */
import { callables } from "./api/registry";
import { loadConfig } from "./config/env";
import { logger } from "./core/logger";
import { createApp, AppDeps } from "./http/app";
import { auth, initFirebase } from "./infra/firebase";
import { handleCallback } from "./modules/chatgpt/auth-flow";
import { getAvatar } from "./modules/profiles/avatar.service";
import { webProfile } from "./modules/profiles/profile.service";

export function productionDeps(): AppDeps {
  return {
    callables,
    verifyIdToken: async (token) => {
      const t = await auth().verifyIdToken(token);
      return { uid: t.uid, email: typeof t.email === "string" ? t.email : undefined };
    },
    getAvatar,
    webProfile: (handle) => webProfile(handle),
    chatgptCallback: (params) => handleCallback(loadConfig().chatgpt, params),
  };
}

if (require.main === module) {
  initFirebase();
  const { port } = loadConfig();
  const server = createApp(productionDeps()).listen(port, () => logger.info(`Lingora backend listening on :${port}`));

  // Render sends SIGTERM on deploys: finish in-flight requests, then exit.
  const shutdown = (signal: string) => {
    logger.info("shutting down", { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
