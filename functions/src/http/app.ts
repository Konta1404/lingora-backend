/**
 * The HTTP server (Render, Docker, local): the callable API plus a few plain routes.
 * Built by a factory with injected dependencies, so tests run it without Firebase.
 */
import express, { ErrorRequestHandler, RequestHandler } from "express";
import { CallableDef, invoke } from "../api/define";
import { CallContext } from "../core/context";
import { AppError, toAppError } from "../core/errors";
import { logger } from "../core/logger";
import { WebProfile } from "../modules/profiles/profile.service";
import { renderProfilePage, sanitizeHandle } from "../modules/web/profile-page";
import { decodeCallable, errorBody } from "./callable-protocol";

export interface VerifiedUser {
  uid: string;
  email?: string;
}

export interface AppDeps {
  callables: Record<string, CallableDef>;
  /** Verifies a Firebase ID token; throws if it isn't valid. */
  verifyIdToken(token: string): Promise<VerifiedUser>;
  getAvatar(uid: string): Promise<{ data: Buffer; type: string } | null>;
  webProfile(handle: string): Promise<WebProfile | null>;
  /** Finishes Sign in with ChatGPT and returns the lingora:// URL to redirect to. */
  chatgptCallback(params: URLSearchParams): Promise<string>;
}

export const BODY_LIMIT = "256kb";

const bearer = (header: string | undefined) => (header?.startsWith("Bearer ") ? header.slice(7) : "");

const accessLog: RequestHandler = (req, res, next) => {
  const started = process.hrtime.bigint();
  res.on("finish", () => {
    if (req.path === "/healthz") return;
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    logger.info("request", { method: req.method, path: req.path, status: res.statusCode, ms: Math.round(ms) });
  });
  next();
};

export function createApp(deps: AppDeps) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(accessLog);
  app.use(express.json({ limit: BODY_LIMIT }));

  app.get("/", (_req, res) => {
    res.json({ service: "lingora-backend", ok: true });
  });
  app.get("/healthz", (_req, res) => {
    res.send("ok");
  });

  // OpenAI redirects the browser here after Sign in with ChatGPT.
  app.get("/chatgptCallback", async (req, res) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(req.query)) if (typeof v === "string") params.set(k, v);
    res.redirect(302, await deps.chatgptCallback(params));
  });

  // Profile photos for signed-in users: GET /avatar/<uid>?v=<version>, "Authorization: Bearer <ID token>".
  app.get("/avatar/:uid", async (req, res) => {
    try {
      await deps.verifyIdToken(bearer(req.get("authorization")));
    } catch {
      res.status(401).end();
      return;
    }
    const avatar = await deps.getAvatar(String(req.params.uid)).catch(() => null);
    if (!avatar) {
      res.status(404).end();
      return;
    }
    res.set("Cache-Control", "private, max-age=31536000, immutable").type(avatar.type).send(avatar.data);
  });

  // Invite links: https://<backend>/u/<handle> shows the profile and opens the app (lingora://add/<handle>).
  app.get("/u/:handle", async (req, res) => {
    const handle = sanitizeHandle(String(req.params.handle));
    const profile = handle ? await deps.webProfile(handle).catch(() => null) : null;
    res
      .set("Cache-Control", "no-store")
      .set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:")
      .set("X-Content-Type-Options", "nosniff")
      .type("html")
      .send(renderProfilePage(handle, profile));
  });

  // The callable API.
  app.post("/:name", async (req, res) => {
    const name = req.params.name;
    const def = Object.prototype.hasOwnProperty.call(deps.callables, name) ? deps.callables[name] : undefined;
    if (!def) {
      res.status(404).json({ error: { status: "NOT_FOUND", message: "Unknown function" } });
      return;
    }
    try {
      const ctx: CallContext = { uid: null };
      const token = bearer(req.get("authorization"));
      if (token) {
        const user = await deps.verifyIdToken(token).catch(() => {
          throw new AppError("unauthenticated", "Your session expired. Sign in again.");
        });
        ctx.uid = user.uid;
        ctx.email = user.email;
      }
      const result = await invoke(def, decodeCallable(req.body?.data ?? {}), ctx);
      res.json({ result: result ?? null });
    } catch (e) {
      const err = toAppError(e);
      if (err.code === "internal") logger.error(`/${name} failed`, { error: e });
      const { status, body } = errorBody(err);
      res.status(status).json(body);
    }
  });

  // Malformed or oversized JSON bodies get a callable-style error instead of Express's HTML page.
  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    const tooLarge = (err as { type?: string }).type === "entity.too.large";
    const appErr = new AppError("invalid-argument", tooLarge ? "Request too large." : "Malformed request.");
    const { body } = errorBody(appErr);
    res.status(tooLarge ? 413 : 400).json(body);
  };
  app.use(onError);

  return app;
}
