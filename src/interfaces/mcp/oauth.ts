import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Response } from "express";
import type { Collection, Db } from "mongodb";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import {
  AccessDeniedError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { Actor, Role, UserDirectory } from "../http/security.js";

export const mcpScopes = [
  "notes:read",
  "notes:write",
  "agenda:read",
  "agenda:write",
  "directory:read",
  "replacements:read",
] as const;
export type McpScope = (typeof mcpScopes)[number];

export const mcpScopeRoles: Record<McpScope, readonly Role[]> = {
  "notes:read": ["admin", "editor", "press", "auditor"],
  "notes:write": ["admin", "editor"],
  "agenda:read": ["admin", "press", "auditor"],
  "agenda:write": ["admin", "press"],
  "directory:read": ["admin", "editor", "press", "directory", "auditor"],
  "replacements:read": ["admin", "press", "auditor"],
};

type PendingAuthorization = {
  id: string;
  clientId: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
  approvedUserId?: string;
  approvedAt?: number;
};

type AuthorizationCode = PendingAuthorization & {
  userId: string;
  codeHash: string;
};

type AccessToken = {
  tokenHash: string;
  clientId: string;
  userId: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
  revoked?: boolean;
};

type RefreshToken = AccessToken & { tokenHash: string };

type OAuthDocument = Record<string, unknown> & { _id: string };

export interface McpOAuthStore {
  getClient(clientId: string): Promise<OAuthClientInformationFull | undefined>;
  registerClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull>;
  createPendingAuthorization(input: Omit<PendingAuthorization, "id">): Promise<string>;
  getPendingAuthorization(id: string): Promise<PendingAuthorization | undefined>;
  approvePendingAuthorization(id: string, userId: string): Promise<PendingAuthorization | undefined>;
  consumePendingAuthorization(id: string): Promise<PendingAuthorization | undefined>;
  createAuthorizationCode(input: Omit<AuthorizationCode, "id" | "codeHash">): Promise<string>;
  getAuthorizationCode(code: string): Promise<AuthorizationCode | undefined>;
  consumeAuthorizationCode(code: string): Promise<AuthorizationCode | undefined>;
  createAccessToken(input: Omit<AccessToken, "tokenHash">): Promise<string>;
  getAccessToken(token: string): Promise<AccessToken | undefined>;
  createRefreshToken(input: Omit<RefreshToken, "tokenHash">): Promise<string>;
  getRefreshToken(token: string): Promise<RefreshToken | undefined>;
  consumeRefreshToken(token: string): Promise<RefreshToken | undefined>;
  revokeToken(token: string): Promise<void>;
}

const tokenHash = (token: string) => createHash("sha256").update(token).digest("base64url");
const opaqueToken = () => randomBytes(32).toString("base64url");
const now = () => Date.now();
const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character,
  );

export class MongoMcpOAuthStore implements McpOAuthStore {
  private readonly clients: Collection<OAuthDocument>;
  private readonly pending: Collection<OAuthDocument>;
  private readonly codes: Collection<OAuthDocument>;
  private readonly accessTokens: Collection<OAuthDocument>;
  private readonly refreshTokens: Collection<OAuthDocument>;

  constructor(db: Db) {
    this.clients = db.collection("mcp_oauth_clients");
    this.pending = db.collection("mcp_oauth_pending");
    this.codes = db.collection("mcp_oauth_codes");
    this.accessTokens = db.collection("mcp_oauth_access_tokens");
    this.refreshTokens = db.collection("mcp_oauth_refresh_tokens");
  }

  async init(): Promise<void> {
    await Promise.all([
      this.pending.createIndex({ expiresAtAt: 1 }, { expireAfterSeconds: 0 }),
      this.codes.createIndex({ expiresAtAt: 1 }, { expireAfterSeconds: 0 }),
      this.accessTokens.createIndex({ expiresAtAt: 1 }, { expireAfterSeconds: 0 }),
      this.refreshTokens.createIndex({ expiresAtAt: 1 }, { expireAfterSeconds: 0 }),
    ]);
  }

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const document = await this.clients.findOne({ _id: clientId });
    if (!document) return undefined;
    const { _id: _ignored, ...client } = document;
    return client as unknown as OAuthClientInformationFull;
  }

  async registerClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
    await this.clients.replaceOne({ _id: client.client_id }, { _id: client.client_id, ...client }, { upsert: true });
    return client;
  }

  async createPendingAuthorization(input: Omit<PendingAuthorization, "id">): Promise<string> {
    const id = randomUUID();
    await this.pending.insertOne({ _id: id, ...input, expiresAtAt: new Date(input.expiresAt) });
    return id;
  }

  async getPendingAuthorization(id: string): Promise<PendingAuthorization | undefined> {
    const document = await this.pending.findOne({ _id: id, expiresAt: { $gt: now() } });
    if (!document) return undefined;
    const { _id: _ignored, ...pending } = document;
    return { id, ...(pending as Omit<PendingAuthorization, "id">) };
  }

  async approvePendingAuthorization(id: string, userId: string): Promise<PendingAuthorization | undefined> {
    const document = await this.pending.findOneAndUpdate(
      {
        _id: id,
        expiresAt: { $gt: now() },
        $or: [{ approvedUserId: { $exists: false } }, { approvedUserId: userId }],
      },
      { $set: { approvedUserId: userId, approvedAt: now() } },
      { returnDocument: "after" },
    );
    if (!document) return undefined;
    const { _id: _ignored, ...pending } = document;
    return { id, ...(pending as Omit<PendingAuthorization, "id">) };
  }

  async consumePendingAuthorization(id: string): Promise<PendingAuthorization | undefined> {
    const document = await this.pending.findOneAndDelete({ _id: id, expiresAt: { $gt: now() } });
    if (!document) return undefined;
    const { _id: _ignored, ...pending } = document;
    return { id, ...(pending as Omit<PendingAuthorization, "id">) };
  }

  async createAuthorizationCode(input: Omit<AuthorizationCode, "id" | "codeHash">): Promise<string> {
    const code = opaqueToken();
    await this.codes.insertOne({
      _id: tokenHash(code),
      ...input,
      codeHash: tokenHash(code),
      expiresAtAt: new Date(input.expiresAt),
    });
    return code;
  }

  async getAuthorizationCode(code: string): Promise<AuthorizationCode | undefined> {
    const document = await this.codes.findOne({ _id: tokenHash(code), expiresAt: { $gt: now() } });
    if (!document) return undefined;
    const { _id: _ignored, ...value } = document;
    return value as unknown as AuthorizationCode;
  }

  async consumeAuthorizationCode(code: string): Promise<AuthorizationCode | undefined> {
    const document = await this.codes.findOneAndDelete({ _id: tokenHash(code), expiresAt: { $gt: now() } });
    if (!document) return undefined;
    const { _id: _ignored, ...value } = document;
    return value as unknown as AuthorizationCode;
  }

  async createAccessToken(input: Omit<AccessToken, "tokenHash">): Promise<string> {
    const token = opaqueToken();
    await this.accessTokens.insertOne({
      _id: tokenHash(token),
      tokenHash: tokenHash(token),
      ...input,
      expiresAtAt: new Date(input.expiresAt),
    });
    return token;
  }

  async getAccessToken(token: string): Promise<AccessToken | undefined> {
    const document = await this.accessTokens.findOne({
      _id: tokenHash(token),
      expiresAt: { $gt: now() },
      revoked: { $ne: true },
    });
    if (!document) return undefined;
    const { _id: _ignored, ...value } = document;
    return value as unknown as AccessToken;
  }

  async createRefreshToken(input: Omit<RefreshToken, "tokenHash">): Promise<string> {
    const token = opaqueToken();
    await this.refreshTokens.insertOne({
      _id: tokenHash(token),
      tokenHash: tokenHash(token),
      ...input,
      expiresAtAt: new Date(input.expiresAt),
    });
    return token;
  }

  async getRefreshToken(token: string): Promise<RefreshToken | undefined> {
    const document = await this.refreshTokens.findOne({
      _id: tokenHash(token),
      expiresAt: { $gt: now() },
      revoked: { $ne: true },
    });
    if (!document) return undefined;
    const { _id: _ignored, ...value } = document;
    return value as unknown as RefreshToken;
  }

  async consumeRefreshToken(token: string): Promise<RefreshToken | undefined> {
    const document = await this.refreshTokens.findOneAndDelete({
      _id: tokenHash(token),
      expiresAt: { $gt: now() },
      revoked: { $ne: true },
    });
    if (!document) return undefined;
    const { _id: _ignored, ...value } = document;
    return value as unknown as RefreshToken;
  }

  async revokeToken(token: string): Promise<void> {
    const hash = tokenHash(token);
    await Promise.all([
      this.accessTokens.updateOne({ _id: hash }, { $set: { revoked: true } }),
      this.refreshTokens.updateOne({ _id: hash }, { $set: { revoked: true } }),
    ]);
  }
}

export class MemoryMcpOAuthStore implements McpOAuthStore {
  private readonly clients = new Map<string, OAuthClientInformationFull>();
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly codes = new Map<string, AuthorizationCode>();
  private readonly accessTokens = new Map<string, AccessToken>();
  private readonly refreshTokens = new Map<string, RefreshToken>();

  async getClient(clientId: string) {
    return this.clients.get(clientId);
  }
  async registerClient(client: OAuthClientInformationFull) {
    this.clients.set(client.client_id, client);
    return client;
  }
  async createPendingAuthorization(input: Omit<PendingAuthorization, "id">) {
    const id = randomUUID();
    this.pending.set(id, { id, ...input });
    return id;
  }
  async getPendingAuthorization(id: string) {
    const value = this.pending.get(id);
    return value && value.expiresAt > now() ? value : undefined;
  }
  async approvePendingAuthorization(id: string, userId: string) {
    const value = this.pending.get(id);
    if (!value || value.expiresAt <= now()) return undefined;
    if (value.approvedUserId && value.approvedUserId !== userId) return undefined;
    value.approvedUserId = userId;
    value.approvedAt = now();
    return value;
  }
  async consumePendingAuthorization(id: string) {
    const value = this.pending.get(id);
    this.pending.delete(id);
    return value && value.expiresAt > now() ? value : undefined;
  }
  async createAuthorizationCode(input: Omit<AuthorizationCode, "id" | "codeHash">) {
    const code = opaqueToken();
    this.codes.set(tokenHash(code), { id: tokenHash(code), codeHash: tokenHash(code), ...input });
    return code;
  }
  async getAuthorizationCode(code: string) {
    const value = this.codes.get(tokenHash(code));
    return value && value.expiresAt > now() ? value : undefined;
  }
  async consumeAuthorizationCode(code: string) {
    const hash = tokenHash(code);
    const value = this.codes.get(hash);
    this.codes.delete(hash);
    return value && value.expiresAt > now() ? value : undefined;
  }
  async createAccessToken(input: Omit<AccessToken, "tokenHash">) {
    const token = opaqueToken();
    this.accessTokens.set(tokenHash(token), { tokenHash: tokenHash(token), ...input });
    return token;
  }
  async getAccessToken(token: string) {
    const value = this.accessTokens.get(tokenHash(token));
    return value && value.expiresAt > now() && !value.revoked ? value : undefined;
  }
  async createRefreshToken(input: Omit<RefreshToken, "tokenHash">) {
    const token = opaqueToken();
    this.refreshTokens.set(tokenHash(token), { tokenHash: tokenHash(token), ...input });
    return token;
  }
  async getRefreshToken(token: string) {
    const value = this.refreshTokens.get(tokenHash(token));
    return value && value.expiresAt > now() && !value.revoked ? value : undefined;
  }
  async consumeRefreshToken(token: string) {
    const hash = tokenHash(token);
    const value = this.refreshTokens.get(hash);
    this.refreshTokens.delete(hash);
    return value && value.expiresAt > now() && !value.revoked ? value : undefined;
  }
  async revokeToken(token: string) {
    const hash = tokenHash(token);
    const access = this.accessTokens.get(hash);
    if (access) access.revoked = true;
    const refresh = this.refreshTokens.get(hash);
    if (refresh) refresh.revoked = true;
  }
}

type McpOAuthOptions = {
  store: McpOAuthStore;
  users: UserDirectory;
  resourceUrl: URL;
  issuerUrl: URL;
};

const scopeLabel = (scope: string) =>
  ({
    "notes:read": "Leer notas",
    "notes:write": "Crear y modificar notas",
    "agenda:read": "Leer agenda y coberturas",
    "directory:read": "Leer directorio editorial",
    "replacements:read": "Leer búsquedas de reemplazo",
  })[scope] ?? scope;

export class McpOAuthProvider implements OAuthServerProvider {
  readonly clientsStore = {
    getClient: (clientId: string) => this.store.getClient(clientId),
    registerClient: (client: OAuthClientInformationFull) => this.store.registerClient(client),
  };

  constructor(private readonly options: McpOAuthOptions) {}

  private get store() {
    return this.options.store;
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, response: Response): Promise<void> {
    if (params.resource && params.resource.href !== this.options.resourceUrl.href) {
      throw new InvalidRequestError("El recurso solicitado no corresponde a Afterstage");
    }
    const unsupported = params.scopes?.filter((scope) => !mcpScopes.includes(scope as McpScope)) ?? [];
    if (unsupported.length) throw new InvalidScopeError(`Scopes no soportados: ${unsupported.join(", ")}`);
    const scopes = params.scopes?.length ? params.scopes : [...mcpScopes];
    const requestId = await this.store.createPendingAuthorization({
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      ...(params.state ? { state: params.state } : {}),
      codeChallenge: params.codeChallenge,
      scopes,
      ...(params.resource ? { resource: params.resource.href } : { resource: this.options.resourceUrl.href }),
      expiresAt: now() + 10 * 60_000,
    });
    const scopeList = scopes
      .map((scope) => `<li>${escapeHtml(scopeLabel(scope))} <code>${escapeHtml(scope)}</code></li>`)
      .join("");
    const sessionActor = response.locals.afterstageActor as Actor | undefined;
    const sessionBlock = sessionActor
      ? `<p>Sesión iniciada en Afterstage. La contraseña no se comparte con esta conexión.</p><form method="post" action="/oauth/approve"><input type="hidden" name="request_id" value="${escapeHtml(requestId)}"><button type="submit">Autorizar conexión</button></form>`
      : `<p>Para continuar, iniciá sesión en Afterstage en otra pestaña y luego volvé a esta pantalla.</p><p><a href="/colaborador" target="_blank" rel="noreferrer">Abrir Afterstage e iniciar sesión</a></p><form method="post" action="/oauth/approve"><input type="hidden" name="request_id" value="${escapeHtml(requestId)}"><button type="submit">Ya inicié sesión, continuar</button></form>`;
    response
      .set("Cache-Control", "no-store")
      .type("html")
      .send(
        `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Conectar Afterstage</title><style>body{font:16px system-ui;background:#f4f0e8;color:#171717;margin:0;padding:32px}.card{background:#fff;border:2px solid #171717;max-width:560px;margin:8vh auto;padding:32px;box-shadow:8px 8px #c7f36a}h1{font-size:42px;letter-spacing:-.06em;margin-top:0}a{color:#171717;font-weight:700}button{background:#171717;color:#fff;border:0;font:inherit;font-weight:700;margin-top:24px;padding:13px 18px;width:100%}button:disabled{cursor:wait;opacity:.7}small{color:#57534e}code{font-size:.8em}</style><main class="card"><h1>Conectar Afterstage</h1><p><strong>${escapeHtml(client.client_name ?? "Una aplicación")}</strong> quiere trabajar con tu cuenta.</p><ul>${scopeList}</ul><small>El acceso queda limitado a estos permisos y puede revocarse.</small>${sessionBlock.replace('<form method="post" action="/oauth/approve">', '<form method="post" action="/oauth/approve" onsubmit="const button=this.querySelector(\'button[type=submit]\'); if(button.disabled) return false; button.disabled=true; button.textContent=\'Autorizando…\';">')}</main></html>`,
      );
  }

  async approveAuthorization(requestId: string, userId: string, response: Response): Promise<void> {
    response.set("Cache-Control", "no-store");
    const request = await this.store.getPendingAuthorization(requestId);
    if (!request) throw new InvalidGrantError("La solicitud OAuth expiró o ya fue utilizada");
    const user = await this.options.users.findActiveUser(userId);
    if (!user || user.active === false) throw new AccessDeniedError("La sesión de Afterstage no es válida");
    const deniedScope = request.scopes.find((scope) => {
      const allowedRoles = mcpScopeRoles[scope as McpScope];
      return !allowedRoles?.some((role) => user.roles.includes(role));
    });
    if (deniedScope) throw new AccessDeniedError(`Tu usuario no tiene permiso para el scope ${deniedScope}`);
    const approved = await this.store.approvePendingAuthorization(requestId, user.id);
    if (!approved) throw new InvalidGrantError("La solicitud OAuth expiró o fue autorizada por otra cuenta");
    const code = await this.store.createAuthorizationCode({
      clientId: approved.clientId,
      redirectUri: approved.redirectUri,
      ...(approved.state ? { state: approved.state } : {}),
      codeChallenge: approved.codeChallenge,
      scopes: approved.scopes,
      ...(approved.resource ? { resource: approved.resource } : {}),
      expiresAt: approved.expiresAt,
      userId: user.id,
    });
    const redirect = new URL(approved.redirectUri);
    redirect.searchParams.set("code", code);
    if (approved.state) redirect.searchParams.set("state", approved.state);
    redirect.searchParams.set("iss", this.options.issuerUrl.href);
    if (redirect.hostname === "127.0.0.1" || redirect.hostname === "localhost") {
      response
        .type("html")
        .send(
          `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Afterstage autorizado</title><style>body{font:16px system-ui;background:#f4f0e8;color:#171717;margin:0;padding:32px}.card{background:#fff;border:2px solid #171717;max-width:720px;margin:8vh auto;padding:32px;box-shadow:8px 8px #c7f36a}h1{margin-top:0}textarea{box-sizing:border-box;width:100%;min-height:120px;border:1px solid #171717;padding:12px;font:13px ui-monospace,monospace}a{display:inline-block;background:#171717;color:#fff;text-decoration:none;padding:13px 18px;margin-top:16px}small{color:#57534e}</style><main class="card"><h1>Afterstage autorizado</h1><p>Copiá esta URL completa y pegala en el prompt de Codex para terminar la conexión:</p><textarea readonly>${escapeHtml(redirect.href)}</textarea><p><a href="${escapeHtml(redirect.href)}">Abrir retorno local</a></p><small>El código es temporal y se puede usar una sola vez.</small></main></html>`,
        );
      return;
    }
    response
      .status(200)
      .type("html")
      .send(
        `<!doctype html><html lang="es"><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${escapeHtml(redirect.href)}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Afterstage autorizado</title><style>body{font:16px system-ui;background:#f4f0e8;color:#171717;margin:0;padding:32px}.card{background:#fff;border:2px solid #171717;max-width:720px;margin:8vh auto;padding:32px;box-shadow:8px 8px #c7f36a}h1{margin-top:0}a{display:inline-block;background:#171717;color:#fff;text-decoration:none;padding:13px 18px;margin-top:16px}small{color:#57534e}</style><main class="card"><h1>Afterstage autorizado</h1><p>Redirigiendo a ChatGPT para completar la conexión…</p><p><a href="${escapeHtml(redirect.href)}">Continuar a ChatGPT</a></p><small>El código es temporal y se puede usar una sola vez.</small></main></html>`,
      );
  }

  async challengeForAuthorizationCode(_client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const code = await this.store.getAuthorizationCode(authorizationCode);
    if (!code) throw new InvalidGrantError("El código de autorización no es válido");
    return code.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const code = await this.store.getAuthorizationCode(authorizationCode);
    if (!code || code.clientId !== client.client_id)
      throw new InvalidGrantError("El código de autorización no es válido");
    if (redirectUri && redirectUri !== code.redirectUri) throw new InvalidGrantError("redirect_uri no coincide");
    if (resource && resource.href !== code.resource) throw new InvalidGrantError("resource no coincide");
    const consumed = await this.store.consumeAuthorizationCode(authorizationCode);
    if (!consumed) throw new InvalidGrantError("El código de autorización ya fue utilizado");
    return this.issueTokens(client.client_id, consumed.userId, consumed.scopes, consumed.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const stored = await this.store.getRefreshToken(refreshToken);
    if (!stored || stored.clientId !== client.client_id) throw new InvalidGrantError("El refresh token no es válido");
    if (resource && resource.href !== stored.resource) throw new InvalidGrantError("resource no coincide");
    const granted = scopes ?? stored.scopes;
    if (granted.some((scope) => !stored.scopes.includes(scope)))
      throw new InvalidScopeError("No se puede ampliar el scope");
    const consumed = await this.store.consumeRefreshToken(refreshToken);
    if (!consumed) throw new InvalidGrantError("El refresh token ya fue utilizado");
    const user = await this.options.users.findActiveUser(stored.userId);
    if (!user || user.active === false) throw new InvalidGrantError("El usuario ya no está activo");
    const deniedScope = stored.scopes.find((scope) => {
      const allowedRoles = mcpScopeRoles[scope as McpScope];
      return !allowedRoles?.some((role) => user.roles.includes(role));
    });
    if (deniedScope) throw new InvalidGrantError(`El usuario ya no tiene permiso para el scope ${deniedScope}`);
    return this.issueTokens(client.client_id, user.id, granted, stored.resource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const stored = await this.store.getAccessToken(token);
    if (!stored) throw new InvalidGrantError("El access token no es válido");
    const user = await this.options.users.findActiveUser(stored.userId);
    if (!user || user.active === false) throw new InvalidGrantError("El usuario ya no está activo");
    return {
      token,
      clientId: stored.clientId,
      scopes: stored.scopes,
      expiresAt: Math.floor(stored.expiresAt / 1000),
      resource: stored.resource ? new URL(stored.resource) : undefined,
      extra: { userId: user.id, roles: user.roles, permissions: user.permissions },
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    await this.store.revokeToken(request.token);
  }

  private async issueTokens(
    clientId: string,
    userId: string,
    scopes: string[],
    resource?: string,
  ): Promise<OAuthTokens> {
    const expiresIn = 3600;
    const accessToken = await this.store.createAccessToken({
      clientId,
      userId,
      scopes,
      ...(resource ? { resource } : {}),
      expiresAt: now() + expiresIn * 1000,
    });
    const refreshToken = await this.store.createRefreshToken({
      clientId,
      userId,
      scopes,
      ...(resource ? { resource } : {}),
      expiresAt: now() + 30 * 24 * 60 * 60_000,
    });
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: "bearer",
      expires_in: expiresIn,
      scope: scopes.join(" "),
    };
  }
}
