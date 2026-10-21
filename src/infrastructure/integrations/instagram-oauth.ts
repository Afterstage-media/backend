import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const requestedScopes = [
  "instagram_business_basic",
  "instagram_business_manage_messages",
  "instagram_business_manage_comments",
  "instagram_business_content_publish",
  "instagram_business_manage_insights",
];

type OAuthState = { actorId: string; nonce: string; expiresAt: number };

const requireConfig = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} no está configurada`);
  return value;
};

const publicBase = (): string => (process.env.PUBLIC_BASE_URL ?? "").replace(/\/$/, "");

export const instagramRedirectUri = (): string =>
  process.env.META_INSTAGRAM_REDIRECT_URI ?? `${publicBase()}/api/integrations/instagram/callback`;

const stateKey = (): Buffer => {
  const value = requireConfig("META_TOKEN_ENCRYPTION_KEY");
  const key = Buffer.from(value, "base64url");
  if (key.length !== 32) throw new Error("META_TOKEN_ENCRYPTION_KEY debe tener 32 bytes en base64url");
  return key;
};

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");

const sign = (value: string): string => createHmac("sha256", stateKey()).update(value).digest("base64url");

export const createInstagramOAuthState = (actorId: string): string => {
  const payload = encode({
    actorId,
    nonce: randomBytes(16).toString("base64url"),
    expiresAt: Date.now() + 10 * 60_000,
  });
  return `${payload}.${sign(payload)}`;
};

export const readInstagramOAuthState = (value: string): OAuthState => {
  const [payload, signature] = value.split(".");
  if (!payload || !signature) throw new Error("Estado OAuth inválido");
  const expected = Buffer.from(sign(payload));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received))
    throw new Error("Estado OAuth inválido");
  const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<OAuthState>;
  if (typeof parsed.actorId !== "string" || typeof parsed.nonce !== "string" || typeof parsed.expiresAt !== "number")
    throw new Error("Estado OAuth inválido");
  if (parsed.expiresAt < Date.now()) throw new Error("La autorización de Instagram expiró");
  return parsed as OAuthState;
};

export const instagramAuthorizationUrl = (actorId: string): string => {
  const url = new URL("https://www.instagram.com/oauth/authorize");
  url.searchParams.set("client_id", requireConfig("META_INSTAGRAM_APP_ID"));
  url.searchParams.set("redirect_uri", instagramRedirectUri());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", requestedScopes.join(","));
  url.searchParams.set("state", createInstagramOAuthState(actorId));
  return url.toString();
};

type TokenResponse = { access_token?: string; user_id?: string | number; expires_in?: number; data?: TokenResponse[] };

const parseTokenResponse = (value: TokenResponse): TokenResponse => {
  if (value.access_token) return value;
  if (value.data?.length === 1 && value.data[0]?.access_token) return value.data[0];
  throw new Error("Meta no devolvió un token de Instagram válido");
};

const formPost = async (url: string, fields: Record<string, string>): Promise<TokenResponse> => {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new Error(`Meta OAuth token request falló: ${error instanceof Error ? error.message : String(error)}`);
  }
  const rawBody = await response.text();
  let payload: TokenResponse & {
    error?: { message?: string; type?: string; code?: number };
    error_message?: string;
    error_type?: string;
    code?: number;
    fbtrace_id?: string;
  } = {};
  try {
    payload = JSON.parse(rawBody) as typeof payload;
  } catch {
    throw new Error(`Meta devolvió una respuesta inválida (${response.status})`);
  }
  const metaMessage = payload.error?.message ?? payload.error_message;
  const metaType = payload.error?.type ?? payload.error_type;
  const metaCode = payload.error?.code ?? payload.code;
  if (!response.ok || payload.error || payload.error_message)
    throw new Error(
      `Meta no aceptó la autorización: ${metaMessage ?? response.status}${
        metaType ? ` (${metaType}${metaCode ? `/${metaCode}` : ""})` : ""
      }`,
    );
  return parseTokenResponse(payload);
};

export const exchangeInstagramCode = async (code: string) => {
  const redirectUri = instagramRedirectUri();
  const clientId = requireConfig("META_INSTAGRAM_APP_ID");
  const shortLived = await formPost("https://api.instagram.com/oauth/access_token", {
    client_id: clientId,
    client_secret: requireConfig("META_INSTAGRAM_APP_SECRET"),
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    code,
  });
  const longLivedUrl = new URL("https://graph.instagram.com/access_token");
  longLivedUrl.searchParams.set("grant_type", "ig_exchange_token");
  longLivedUrl.searchParams.set("client_secret", requireConfig("META_INSTAGRAM_APP_SECRET"));
  longLivedUrl.searchParams.set("access_token", shortLived.access_token!);
  let longResponse: Response;
  try {
    longResponse = await fetch(longLivedUrl, { signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    throw new Error(`Meta token largo falló: ${error instanceof Error ? error.message : String(error)}`);
  }
  const longRawBody = await longResponse.text();
  let longPayload = {} as TokenResponse & {
    error?: { message?: string; type?: string; code?: number };
    error_message?: string;
    error_type?: string;
    code?: number;
    fbtrace_id?: string;
  };
  try {
    longPayload = JSON.parse(longRawBody) as typeof longPayload;
  } catch {
    throw new Error(`Meta devolvió una respuesta inválida para el token largo (${longResponse.status})`);
  }
  if (!longResponse.ok || longPayload.error || !longPayload.access_token)
    throw new Error(
      `Meta no devolvió un token de larga duración: ${longPayload.error?.message ?? longPayload.error_message ?? longResponse.status}`,
    );

  const profileUrl = new URL("https://graph.instagram.com/me");
  profileUrl.searchParams.set("fields", "user_id,username");
  profileUrl.searchParams.set("access_token", longPayload.access_token);
  let profileResponse: Response;
  try {
    profileResponse = await fetch(profileUrl, { signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    throw new Error(`Meta perfil falló: ${error instanceof Error ? error.message : String(error)}`);
  }
  const profileRawBody = await profileResponse.text();
  let profile = {} as {
    user_id?: string;
    username?: string;
    error?: { message?: string; type?: string; code?: number };
    error_message?: string;
    error_type?: string;
    code?: number;
    fbtrace_id?: string;
  };
  try {
    profile = JSON.parse(profileRawBody) as typeof profile;
  } catch {
    throw new Error(`Meta devolvió una respuesta inválida del perfil (${profileResponse.status})`);
  }
  if (!profileResponse.ok || profile.error || !profile.user_id)
    throw new Error(
      `Meta no devolvió los datos de la cuenta: ${profile.error?.message ?? profile.error_message ?? profileResponse.status}`,
    );

  return {
    accountId: profile.user_id,
    username: profile.username ?? profile.user_id,
    accessToken: longPayload.access_token,
    expiresAt:
      typeof longPayload.expires_in === "number"
        ? new Date(Date.now() + longPayload.expires_in * 1000).toISOString()
        : null,
    scopes: requestedScopes,
  };
};
