/**
 * Sign in with ChatGPT (OpenAI preview): users power Lingora's AI with their own ChatGPT Plus/Pro plan.
 *
 * Flow: app → chatgptAuthStart → browser → OpenAI → GET /chatgptCallback
 *       → tokens encrypted into users/{uid}/private/chatgpt → lingora://chatgpt?… → chatgptAuthFinish.
 * Signed-in users link their plan; anyone else gets a Lingora account made from their ChatGPT identity.
 */
import { createHash, randomBytes } from "crypto";
import { FieldValue } from "firebase-admin/firestore";
import { jwtVerify } from "jose";
import { ChatGPTConfig } from "../../config/env";
import { col } from "../../infra/collections";
import { auth } from "../../infra/firebase";
import { listModels, pickModel } from "./models";
import { oidc, tokenRequest, PLAN_SCOPES, RESOURCE } from "./oidc";
import { saveTokens } from "./tokens";

const b64url = (b: Buffer) => b.toString("base64url");

/** Stable Firebase uid for a ChatGPT identity. */
export const chatgptUid = (issuer: string, clientId: string, sub: string) =>
  `chatgpt_${createHash("sha256").update(`${issuer}|${clientId}|${sub}`).digest("hex").slice(0, 28)}`;

/** Creates a pending sign-in (state, nonce, PKCE verifier) and returns OpenAI's authorize URL. */
export async function startAuth(cfg: ChatGPTConfig, uid: string | null): Promise<string> {
  const { doc } = await oidc(cfg);
  const state = b64url(randomBytes(24));
  const nonce = b64url(randomBytes(16));
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  await col.chatgptPending().doc(state).set({ uid, nonce, verifier, createdAt: FieldValue.serverTimestamp(), status: "started" });
  const q = new URLSearchParams({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: cfg.callbackUrl,
    scope: PLAN_SCOPES,
    resource: RESOURCE,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${doc.authorization_endpoint}?${q}`;
}

/** Handles OpenAI's redirect and returns the lingora:// URL to send the browser back to. Never throws. */
export async function handleCallback(cfg: ChatGPTConfig, params: URLSearchParams): Promise<string> {
  const state = params.get("state") ?? "";
  const back = (status: string, extra: Record<string, string> = {}) =>
    `lingora://chatgpt?${new URLSearchParams({ status, state, ...extra })}`;
  const pendingRef = col.chatgptPending().doc(state || "-");
  const pending = state ? await pendingRef.get().catch(() => null) : null;
  if (!pending?.exists) return back("error", { message: "This sign-in link expired. Try again." });
  if (params.get("error")) {
    await pendingRef.delete();
    return back("cancelled", { message: params.get("error_description") ?? "" });
  }

  try {
    const tok = await tokenRequest(cfg, {
      grant_type: "authorization_code",
      code: params.get("code") ?? "",
      redirect_uri: cfg.callbackUrl,
      code_verifier: pending.get("verifier"),
      client_id: cfg.clientId,
    });
    if (!(tok.scope ?? "").split(" ").includes("chatgpt.tokens.use.direct")) {
      await pendingRef.delete();
      return back("declined", { message: "Lingora needs permission to use your ChatGPT plan." });
    }
    const { doc, jwks } = await oidc(cfg);
    const { payload } = await jwtVerify(tok.id_token ?? "", jwks, { issuer: doc.issuer, audience: cfg.clientId });
    if (payload.nonce !== pending.get("nonce")) throw new Error("Nonce mismatch");
    const sub = String(payload.sub);
    const email = typeof payload.email === "string" ? payload.email : undefined;
    const name = typeof payload.name === "string" ? payload.name : undefined;

    let uid: string = pending.get("uid");
    let customToken = "";
    if (!uid) {
      uid = chatgptUid(doc.issuer, cfg.clientId, sub);
      try {
        await auth().getUser(uid);
      } catch {
        await auth().createUser({ uid, displayName: name, email: email && payload.email_verified ? email : undefined });
      }
      customToken = await auth().createCustomToken(uid, { provider: "chatgpt" });
    }

    await saveTokens(cfg, uid, {
      access: tok.access_token,
      refresh: tok.refresh_token ?? "",
      expiresAt: Date.now() + (tok.expires_in ?? 3600) * 1000,
      model: pickModel(await listModels(tok.access_token), cfg.preferredModels),
      sub,
      email: email ?? null,
      name: name ?? null,
    });
    await pendingRef.set({ status: "done", uid, customToken, name: name ?? null, email: email ?? null }, { merge: true });
    return back("ok");
  } catch (e) {
    await pendingRef.delete().catch(() => undefined);
    return back("error", { message: e instanceof Error ? e.message : String(e) });
  }
}

/** Called by the app after the redirect. Returns a Firebase custom token for new ChatGPT sign-ins. */
export async function finishAuth(state: string) {
  if (!state) return { ok: false };
  const ref = col.chatgptPending().doc(state);
  const snap = await ref.get();
  if (!snap.exists || snap.get("status") !== "done") return { ok: false };
  await ref.delete();
  return { ok: true, customToken: snap.get("customToken") || null, name: snap.get("name"), email: snap.get("email") };
}
