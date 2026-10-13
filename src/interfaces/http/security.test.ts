import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHmac } from "node:crypto";
import {
  actorFromJwt,
  actorFromRequest,
  audit,
  authenticateUser,
  configureUserDirectory,
  hashPassword,
  issueAccessToken,
  verifyPassword,
  type ActiveUser,
} from "./security.js";

const request = (headers: Record<string, string> = {}) =>
  ({
    get: (name: string) => headers[name.toLowerCase()],
    method: "POST",
    originalUrl: "/api/test",
    ip: "127.0.0.1",
  }) as any;

test("resuelve actor por bearer o api key y no acepta tokens parciales", () => {
  const previous = {
    admin: process.env.ADMIN_TOKEN,
    users: process.env.AUTH_USERS_JSON,
  };
  process.env.ADMIN_TOKEN = "secret-token";
  process.env.AUTH_USERS_JSON = JSON.stringify([
    { id: "ed", token: "editor-token", roles: ["editor"], permissions: [] },
  ]);
  assert.deepEqual(actorFromRequest(request({ authorization: "Bearer secret-token" })), {
    id: "admin",
    roles: ["admin"],
    permissions: ["instagram:read", "instagram:metrics", "instagram:publish"],
  });
  assert.deepEqual(actorFromRequest(request({ "x-api-key": "editor-token" })), {
    id: "ed",
    roles: ["editor"],
    permissions: [],
  });
  assert.equal(actorFromRequest(request({ authorization: "Bearer secret" })), undefined);
  if (previous.admin === undefined) delete process.env.ADMIN_TOKEN;
  else process.env.ADMIN_TOKEN = previous.admin;
  if (previous.users === undefined) delete process.env.AUTH_USERS_JSON;
  else process.env.AUTH_USERS_JSON = previous.users;
});

test("escribe auditoría estructurada con actor y metadata", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "medio-under-audit-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = directory;
  const req = request({ authorization: "Bearer none" });
  (req as any).actor = { id: "tester", roles: ["admin"], permissions: [] };
  await audit(req, "test_action", { id: "123" });
  const line = JSON.parse((await readFile(path.join(directory, "audit.jsonl"), "utf8")).trim());
  assert.equal(line.action, "test_action");
  assert.deepEqual(line.actor, { id: "tester", roles: ["admin"], permissions: [] });
  assert.equal(line.metadata.id, "123");
  if (previous === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previous;
});

test("verifica firma, expiración y usuario activo en Mongo antes de aceptar JWT", async () => {
  const previous = {
    secret: process.env.JWT_SECRET,
    issuer: process.env.JWT_ISSUER,
  };
  process.env.JWT_SECRET = "jwt-test-secret";
  process.env.JWT_ISSUER = "medio-under";
  configureUserDirectory({
    findActiveUser: async (id) =>
      id === "user-1" ? { id, roles: ["editor"], permissions: [], active: true } : undefined,
  });
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    sub: "user-1",
    roles: ["editor"],
    permissions: [],
    iss: "medio-under",
    exp: Math.floor(Date.now() / 1000) + 300,
  });
  const sign = (body: string, secret = process.env.JWT_SECRET!) =>
    createHmac("sha256", secret).update(body).digest("base64url");
  const valid = `${header}.${payload}.${sign(`${header}.${payload}`)}`;
  assert.deepEqual(await actorFromJwt(valid), { id: "user-1", roles: ["editor"], permissions: [] });
  assert.equal(await actorFromJwt(`${header}.${payload}.${sign(`${header}.${payload}`, "wrong")}`), undefined);
  const expiredPayload = encode({
    sub: "user-1",
    roles: ["editor"],
    permissions: [],
    iss: "medio-under",
    exp: Math.floor(Date.now() / 1000) - 60,
  });
  assert.equal(await actorFromJwt(`${header}.${expiredPayload}.${sign(`${header}.${expiredPayload}`)}`), undefined);
  configureUserDirectory(undefined);
  if (previous.secret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previous.secret;
  if (previous.issuer === undefined) delete process.env.JWT_ISSUER;
  else process.env.JWT_ISSUER = previous.issuer;
});

test("autentica contraseñas con scrypt y emite JWT de corta duración", async () => {
  const previous = {
    secret: process.env.JWT_SECRET,
    issuer: process.env.JWT_ISSUER,
  };
  process.env.JWT_SECRET = "login-test-secret";
  process.env.JWT_ISSUER = "medio-under";
  const passwordHash = await hashPassword("una-clave-segura-123");
  assert.equal(await verifyPassword("una-clave-segura-123", passwordHash), true);
  assert.equal(await verifyPassword("otra-clave-123", passwordHash), false);
  configureUserDirectory({
    findActiveUser: async (id) =>
      id === "login-user" ? { id, roles: ["editor"], permissions: [], active: true } : undefined,
    findByIdentifier: async (identifier) =>
      identifier === "redaccion"
        ? { id: "login-user", roles: ["editor"], permissions: [], active: true, passwordHash }
        : undefined,
  });
  const user = await authenticateUser("redaccion", "una-clave-segura-123");
  assert.deepEqual(user, { id: "login-user", roles: ["editor"], permissions: [], active: true });
  const token = issueAccessToken(user);
  assert.deepEqual(await actorFromJwt(token), { id: "login-user", roles: ["editor"], permissions: [] });
  configureUserDirectory(undefined);
  if (previous.secret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previous.secret;
  if (previous.issuer === undefined) delete process.env.JWT_ISSUER;
  else process.env.JWT_ISSUER = previous.issuer;
});

test("emite y revalida múltiples roles y permisos contra el directorio", async () => {
  const previous = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "multi-role-secret";
  const user: ActiveUser = {
    id: "social-editor",
    roles: ["editor", "social"],
    permissions: ["instagram:metrics", "instagram:publish"],
    active: true,
  };
  configureUserDirectory({ findActiveUser: async () => user });
  const token = issueAccessToken(user);
  assert.deepEqual(await actorFromJwt(token), {
    id: user.id,
    roles: [...user.roles!],
    permissions: [...user.permissions!],
  });
  configureUserDirectory({ findActiveUser: async () => ({ ...user, permissions: ["instagram:metrics"] }) });
  assert.equal(await actorFromJwt(token), undefined);
  configureUserDirectory(undefined);
  if (previous === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previous;
});
