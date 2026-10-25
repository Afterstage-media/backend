import assert from "node:assert/strict";
import test from "node:test";
import { type ActiveUser, type UserDirectory } from "../http/security.js";
import { MemoryMcpOAuthStore, McpOAuthProvider } from "./oauth.js";

const response = () => {
  const result: { body?: string; redirectTo?: string; redirectStatus?: number } = {};
  return {
    result,
    locals: {},
    status(status: number) {
      result.redirectStatus = status;
      return this;
    },
    type() {
      return this;
    },
    send(body: string) {
      result.body = body;
      return this;
    },
    redirect(status: number, url: string) {
      result.redirectStatus = status;
      result.redirectTo = url;
      return this;
    },
    set() {
      return this;
    },
  };
};

test("emite tokens OAuth por usuario, cliente y scope sin credenciales en entorno", async () => {
  const user: ActiveUser = { id: "editor-1", roles: ["editor"], permissions: [], active: true };
  const users: UserDirectory = {
    findActiveUser: async (id: string) => (id === user.id ? user : undefined),
  };
  const resourceUrl = new URL("https://afterstage.ar/mcp");
  const store = new MemoryMcpOAuthStore();
  const provider = new McpOAuthProvider({
    store,
    users,
    resourceUrl,
    issuerUrl: new URL("https://afterstage.ar/"),
  });
  const client = {
    client_id: "codex-client",
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: ["http://127.0.0.1:43123/callback"],
    token_endpoint_auth_method: "none",
  };
  await provider.clientsStore.registerClient(client);

  const authorization = response();
  await provider.authorize(
    client,
    {
      redirectUri: client.redirect_uris[0]!,
      codeChallenge: "challenge",
      scopes: ["notes:read", "notes:write"],
      state: "state-1",
      resource: resourceUrl,
    },
    authorization as never,
  );
  const requestId = authorization.result.body?.match(/name="request_id" value="([^"]+)"/)?.[1];
  assert.ok(requestId);
  assert.doesNotMatch(authorization.result.body ?? "", /name="password"/);
  assert.match(authorization.result.body ?? "", /Abrir Afterstage e iniciar sesión/);

  const approval = response();
  await provider.approveAuthorization(requestId, user.id, approval as never);
  const callbackUrl =
    approval.result.redirectTo ??
    approval.result.body?.match(/<textarea readonly>(.*?)<\/textarea>/)?.[1]?.replaceAll("&amp;", "&");
  const code = new URL(callbackUrl!).searchParams.get("code");
  assert.ok(code);
  assert.equal(await provider.challengeForAuthorizationCode(client, code), "challenge");

  const duplicateApproval = response();
  await provider.approveAuthorization(requestId, user.id, duplicateApproval as never);
  const duplicateCallbackUrl =
    duplicateApproval.result.redirectTo ??
    duplicateApproval.result.body?.match(/<textarea readonly>(.*?)<\/textarea>/)?.[1]?.replaceAll("&amp;", "&");
  assert.ok(duplicateCallbackUrl);
  assert.notEqual(new URL(duplicateCallbackUrl).searchParams.get("code"), code);

  const tokens = await provider.exchangeAuthorizationCode(
    client,
    code,
    undefined,
    client.redirect_uris[0],
    resourceUrl,
  );
  assert.equal(tokens.token_type, "bearer");
  assert.equal(tokens.scope, "notes:read notes:write");
  assert.ok(tokens.refresh_token);

  const authInfo = await provider.verifyAccessToken(tokens.access_token);
  assert.deepEqual(authInfo.extra, { userId: user.id, roles: ["editor"], permissions: [] });
  assert.deepEqual(authInfo.scopes, ["notes:read", "notes:write"]);
  const grants = await store.listAccessGrants(user.id);
  assert.equal(grants.length, 1);
  assert.equal(grants[0]?.clientId, client.client_id);
  assert.deepEqual(grants[0]?.scopes, ["notes:read", "notes:write"]);
  assert.equal(await store.revokeAccessGrant(user.id, grants[0]!.id), true);
  await assert.rejects(() => provider.verifyAccessToken(tokens.access_token), /access token no es válido/);

  const webClient = {
    ...client,
    client_id: "chatgpt-client",
    redirect_uris: ["https://chatgpt.com/connector/oauth/callback"],
  };
  await provider.clientsStore.registerClient(webClient);
  const webAuthorization = response();
  await provider.authorize(
    webClient,
    {
      redirectUri: webClient.redirect_uris[0]!,
      codeChallenge: "web-challenge",
      scopes: ["notes:read"],
      resource: resourceUrl,
    },
    webAuthorization as never,
  );
  const webRequestId = webAuthorization.result.body?.match(/name="request_id" value="([^"]+)"/)?.[1];
  assert.ok(webRequestId);
  const webApproval = response();
  await provider.approveAuthorization(webRequestId, user.id, webApproval as never);
  assert.equal(webApproval.result.redirectStatus, 200);
  assert.match(webApproval.result.body ?? "", /Redirigiendo a ChatGPT/);
  const webCallbackUrl = webApproval.result.body
    ?.match(/<a href="([^"]+)">Continuar a ChatGPT/)?.[1]
    ?.replaceAll("&amp;", "&");
  assert.equal(new URL(webCallbackUrl!).origin, "https://chatgpt.com");
  assert.equal(new URL(webCallbackUrl!).searchParams.get("iss"), "https://afterstage.ar/");
});
