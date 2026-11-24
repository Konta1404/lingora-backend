/** OpenID Connect plumbing for Sign in with ChatGPT: discovery, JWKS and the token endpoint. */
import { createRemoteJWKSet } from "jose";
import { ChatGPTConfig } from "../../config/env";
import { PlanError } from "../../core/errors";

export const PLAN_SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
export const RESOURCE = "https://api.openai.com/v1";

export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  scope?: string;
}

let discovery: Promise<{ doc: Discovery; jwks: ReturnType<typeof createRemoteJWKSet> }> | null = null;

/** Discovery document and key set, fetched once per process. A failed fetch is retried next time. */
export function oidc(cfg: ChatGPTConfig) {
  discovery ??= (async () => {
    const res = await fetch(cfg.discoveryUrl);
    if (!res.ok) throw new Error(`OIDC discovery failed (${res.status})`);
    const doc = (await res.json()) as Discovery;
    return { doc, jwks: createRemoteJWKSet(new URL(doc.jwks_uri)) };
  })().catch((e) => {
    discovery = null;
    throw e;
  });
  return discovery;
}

export async function tokenRequest(cfg: ChatGPTConfig, body: Record<string, string>): Promise<TokenResponse> {
  const { doc } = await oidc(cfg);
  const basic = Buffer.from(`${encodeURIComponent(cfg.clientId)}:${encodeURIComponent(cfg.clientSecret)}`).toString("base64");
  const res = await fetch(doc.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
    body: new URLSearchParams(body),
  });
  const json = (await res.json()) as TokenResponse & { error?: string; error_description?: string };
  if (!res.ok) {
    if (json.error === "invalid_grant") throw new PlanError("ChatGPT access was revoked. Connect again.", "revoked");
    throw new PlanError(json.error_description || json.error || `Token request failed (${res.status})`, "failed");
  }
  return json;
}
