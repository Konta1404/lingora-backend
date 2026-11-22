/**
 * Sign in with ChatGPT (OpenAI preview): users power Lingora with their own ChatGPT Plus/Pro plan.
 *
 * Paid/hosted apps need a client ID from OpenAI: https://openai.com/form/sign-in-with-chatgpt-interest/
 * Register this redirect URI with OpenAI:  https://<region>-<project>.cloudfunctions.net/chatgptCallback
 *
 * Flow: app → chatgptAuthStart (callable) → browser → OpenAI → chatgptCallback (HTTPS)
 *       → tokens encrypted into users/{uid}/private/chatgpt → lingora://chatgpt?... → chatgptAuthFinish (callable)
 */
import { createHash, randomBytes } from "crypto";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { encrypt, decrypt } from "./crypto";

export const PLAN_SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
export const RESOURCE = "https://api.openai.com/v1";

export interface Config {
  clientId: string;
  clientSecret: string;
  encKey: string;
  discoveryUrl: string;
  callbackUrl: string;
  preferredModels: string[];
}

export class PlanError extends Error {
  constructor(message: string, readonly code: "not-connected" | "limit" | "not-eligible" | "revoked" | "failed") {
    super(message);
  }
}

// ---------- OIDC discovery ----------

interface Discovery { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string }
let discovery: Discovery | null = null;
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

async function oidc(cfg: Config): Promise<Discovery> {
  if (!discovery) {
    const res = await fetch(cfg.discoveryUrl);
    if (!res.ok) throw new Error(`OIDC discovery failed (${res.status})`);
    discovery = (await res.json()) as Discovery;
    jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
  }
  return discovery;
}

const b64url = (b: Buffer) => b.toString("base64url");

// ---------- Start / callback / finish ----------

export async function startAuth(cfg: Config, uid: string | null): Promise<string> {
  const d = await oidc(cfg);
  const state = b64url(randomBytes(24));
  const nonce = b64url(randomBytes(16));
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  await getFirestore().collection("chatgptPending").doc(state).set({
    uid, nonce, verifier, createdAt: FieldValue.serverTimestamp(), status: "started",
  });
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
  return `${d.authorization_endpoint}?${q}`;
}

interface TokenResponse { access_token: string; refresh_token?: string; id_token?: string; expires_in?: number; scope?: string }

async function tokenRequest(cfg: Config, body: Record<string, string>): Promise<TokenResponse> {
  const d = await oidc(cfg);
  const res = await fetch(d.token_endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(`${encodeURIComponent(cfg.clientId)}:${encodeURIComponent(cfg.clientSecret)}`).toString("base64"),
    },
    body: new URLSearchParams(body),
  });
  const json = (await res.json()) as TokenResponse & { error?: string; error_description?: string };
  if (!res.ok) {
    if (json.error === "invalid_grant") throw new PlanError("ChatGPT access was revoked. Connect again.", "revoked");
    throw new PlanError(json.error_description || json.error || `Token request failed (${res.status})`, "failed");
  }
  return json;
}

/** Handles OpenAI's redirect. Returns the app URL to redirect the browser to. */
export async function handleCallback(cfg: Config, params: URLSearchParams): Promise<string> {
  const state = params.get("state") ?? "";
  const back = (status: string, extra: Record<string, string> = {}) =>
    `lingora://chatgpt?${new URLSearchParams({ status, state, ...extra })}`;
  const db = getFirestore();
  const pendingRef = db.collection("chatgptPending").doc(state);
  const pending = state ? await pendingRef.get() : null;
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
    const scopes = (tok.scope ?? "").split(" ");
    if (!scopes.includes("chatgpt.tokens.use.direct")) {
      await pendingRef.delete();
      return back("declined", { message: "Lingora needs permission to use your ChatGPT plan." });
    }
    const d = await oidc(cfg);
    const { payload } = await jwtVerify(tok.id_token ?? "", jwks!, { issuer: d.issuer, audience: cfg.clientId });
    if (payload.nonce !== pending.get("nonce")) throw new Error("Nonce mismatch");
    const sub = String(payload.sub);
    const email = typeof payload.email === "string" ? payload.email : undefined;
    const name = typeof payload.name === "string" ? payload.name : undefined;

    // Signed-in users link their plan; otherwise ChatGPT becomes their Lingora account.
    let uid: string = pending.get("uid");
    let customToken = "";
    if (!uid) {
      uid = `chatgpt_${createHash("sha256").update(`${d.issuer}|${cfg.clientId}|${sub}`).digest("hex").slice(0, 28)}`;
      try {
        await getAuth().getUser(uid);
      } catch {
        await getAuth().createUser({ uid, displayName: name, email: email && payload.email_verified ? email : undefined });
      }
      customToken = await getAuth().createCustomToken(uid, { provider: "chatgpt" });
    }

    const models = await listModels(tok.access_token);
    await saveTokens(cfg, uid, {
      access: tok.access_token,
      refresh: tok.refresh_token ?? "",
      expiresAt: Date.now() + (tok.expires_in ?? 3600) * 1000,
      model: pickModel(models, cfg.preferredModels),
      sub, email: email ?? null, name: name ?? null,
    });
    await pendingRef.set({ status: "done", uid, customToken, name: name ?? null, email: email ?? null }, { merge: true });
    return back("ok");
  } catch (e) {
    await pendingRef.delete().catch(() => undefined);
    return back("error", { message: e instanceof Error ? e.message : String(e) });
  }
}

/** Called by the app after the redirect: returns a Firebase custom token for new ChatGPT sign-ins. */
export async function finishAuth(state: string) {
  const ref = getFirestore().collection("chatgptPending").doc(state);
  const snap = await ref.get();
  if (!snap.exists || snap.get("status") !== "done") return { ok: false };
  await ref.delete();
  return { ok: true, customToken: snap.get("customToken") || null, name: snap.get("name"), email: snap.get("email") };
}

// ---------- Token storage ----------

interface Tokens { access: string; refresh: string; expiresAt: number; model: string; sub: string; email: string | null; name: string | null }

const tokenRef = (uid: string) => getFirestore().collection("users").doc(uid).collection("private").doc("chatgpt");

async function saveTokens(cfg: Config, uid: string, t: Tokens) {
  await tokenRef(uid).set({
    box: encrypt(JSON.stringify(t), cfg.encKey),
    model: t.model,
    email: t.email,
    connectedAt: FieldValue.serverTimestamp(),
  });
}

export async function status(uid: string) {
  const snap = await tokenRef(uid).get();
  return snap.exists
    ? { connected: true, email: snap.get("email") ?? null, model: snap.get("model") ?? null }
    : { connected: false, email: null, model: null };
}

export async function disconnect(uid: string) {
  await tokenRef(uid).delete();
}

/** A valid access token + model for this user, refreshing when it's about to expire. */
export async function accessFor(cfg: Config, uid: string): Promise<{ token: string; model: string }> {
  const snap = await tokenRef(uid).get();
  if (!snap.exists) throw new PlanError("Connect your ChatGPT account to use AI features.", "not-connected");
  let t = JSON.parse(decrypt(snap.get("box"), cfg.encKey)) as Tokens;
  if (Date.now() > t.expiresAt - 120_000) {
    try {
      const r = await tokenRequest(cfg, { grant_type: "refresh_token", refresh_token: t.refresh, client_id: cfg.clientId });
      t = { ...t, access: r.access_token, refresh: r.refresh_token ?? t.refresh, expiresAt: Date.now() + (r.expires_in ?? 3600) * 1000 };
      await saveTokens(cfg, uid, t);
    } catch (e) {
      if (e instanceof PlanError && e.code === "revoked") await disconnect(uid);
      throw e;
    }
  }
  return { token: t.access, model: t.model };
}

// ---------- Models ----------

async function listModels(token: string): Promise<string[]> {
  try {
    const res = await fetch(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: { id: string }[] };
    return (json.data ?? []).map((m) => m.id);
  } catch {
    return [];
  }
}

function pickModel(available: string[], preferred: string[]): string {
  for (const p of preferred) if (available.includes(p)) return p;
  return available.find((m) => /^gpt-/.test(m) && !/(audio|realtime|transcribe|tts|image|search)/.test(m)) ?? preferred[0];
}
