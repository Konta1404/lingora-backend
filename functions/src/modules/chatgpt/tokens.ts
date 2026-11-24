/** Encrypted storage of a user's ChatGPT tokens in users/{uid}/private/chatgpt, plus refresh. */
import { FieldValue } from "firebase-admin/firestore";
import { ChatGPTConfig } from "../../config/env";
import { PlanError } from "../../core/errors";
import { chatgptTokenDoc } from "../../infra/collections";
import { encrypt, decrypt } from "../../infra/crypto";
import { AIClient } from "../../infra/openai/client";
import { tokenRequest } from "./oidc";

export interface StoredTokens {
  access: string;
  refresh: string;
  /** Epoch ms. */
  expiresAt: number;
  model: string;
  sub: string;
  email: string | null;
  name: string | null;
}

/** Refresh when less than this is left on the access token. */
const REFRESH_MARGIN_MS = 120_000;

export async function saveTokens(cfg: ChatGPTConfig, uid: string, t: StoredTokens) {
  await chatgptTokenDoc(uid).set({
    box: encrypt(JSON.stringify(t), cfg.encKey),
    model: t.model,
    email: t.email,
    connectedAt: FieldValue.serverTimestamp(),
  });
}

export async function status(uid: string) {
  const snap = await chatgptTokenDoc(uid).get();
  return snap.exists
    ? { connected: true, email: snap.get("email") ?? null, model: snap.get("model") ?? null }
    : { connected: false, email: null, model: null };
}

export async function disconnect(uid: string) {
  await chatgptTokenDoc(uid).delete();
}

/** A valid access token and model for this user, refreshing it when it's about to expire. */
export async function accessFor(cfg: ChatGPTConfig, uid: string): Promise<AIClient> {
  const snap = await chatgptTokenDoc(uid).get();
  if (!snap.exists) throw new PlanError("Connect your ChatGPT account to use AI features.", "not-connected");
  let t = JSON.parse(decrypt(snap.get("box"), cfg.encKey)) as StoredTokens;
  if (Date.now() > t.expiresAt - REFRESH_MARGIN_MS) {
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
