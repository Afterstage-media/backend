import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import {
  constants,
  createHash,
  createHmac,
  generateKeyPairSync,
  privateDecrypt,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import type { Request, RequestHandler, Response } from "express";

export type Role = "admin" | "editor" | "press" | "directory" | "community" | "auditor" | "social";
export const permissionNames = ["instagram:read", "instagram:metrics", "instagram:publish"] as const;
export type Permission = (typeof permissionNames)[number];
export type Actor = { id: string; roles: Role[]; permissions: Permission[] };

export type ActiveUser = {
  id: string;
  roles: Role[];
  permissions: Permission[];
  active?: boolean;
  email?: string;
  sessionVersion?: number;
};
export type ManagedUser = ActiveUser & {
  username?: string;
  email?: string;
  createdAt?: string;
  updatedAt?: string;
  lastLoginAt?: string;
};
export type ManagedUserInput = {
  id: string;
  username: string;
  email: string;
  passwordHash: string;
  roles: Role[];
  permissions: Permission[];
  active: boolean;
};
export type UserDirectory = {
  findActiveUser: (id: string) => Promise<ActiveUser | undefined>;
  findByIdentifier?: (identifier: string) => Promise<(ActiveUser & { passwordHash?: string }) | undefined>;
  createCollaborator?: (email: string, passwordHash: string) => Promise<ActiveUser>;
  createPasswordReset?: (userId: string, tokenHash: string, expiresAt: string) => Promise<void>;
  completePasswordReset?: (tokenHash: string, passwordHash: string) => Promise<boolean>;
  listUsers?: () => Promise<ManagedUser[]>;
  createUser?: (input: ManagedUserInput) => Promise<ManagedUser>;
  updateUser?: (
    id: string,
    patch: Partial<Omit<ManagedUserInput, "id" | "passwordHash">> & { passwordHash?: string },
  ) => Promise<ManagedUser | undefined>;
  isSessionRevoked?: (userId: string, jti: string) => Promise<boolean>;
  revokeSession?: (userId: string, jti: string, expiresAt: Date) => Promise<void>;
};
const passwordCost = 16384;
const passwordBlockSize = 8;
const passwordParallelization = 1;
const passwordKeyLength = 32;
const derivePassword = (password: string, salt: string, cost: number, blockSize: number, parallelization: number) =>
  new Promise<Buffer>((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      passwordKeyLength,
      { N: cost, r: blockSize, p: parallelization, maxmem: 128 * cost * blockSize + 2 * 1024 * 1024 },
      (error, derived) => (error ? reject(error) : resolve(derived as Buffer)),
    );
  });
let userDirectory: UserDirectory | undefined;
export class SessionVerificationUnavailable extends Error {
  constructor() {
    super("No se pudo verificar la sesión contra el directorio de usuarios");
  }
}

const authEncryptionKeys = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "der" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const authEncryptionPublicKey = authEncryptionKeys.publicKey.toString("base64url");
const authEncryptionKeyId = createHash("sha256").update(authEncryptionPublicKey).digest("hex").slice(0, 16);

export const getAuthEncryptionPublicKey = () => ({
  keyId: authEncryptionKeyId,
  publicKey: authEncryptionPublicKey,
});

export const decryptAuthSecret = (ciphertext: string, keyId: string): string => {
  if (keyId !== authEncryptionKeyId) throw new Error("Clave de cifrado inválida");
  const plaintext = privateDecrypt(
    { key: authEncryptionKeys.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(ciphertext, "base64url"),
  ).toString("utf8");
  if (!plaintext || plaintext.length > 200) throw new Error("Credencial inválida");
  return plaintext;
};

export const configureUserDirectory = (directory?: UserDirectory) => {
  userDirectory = directory;
};

export const hashPassword = async (password: string): Promise<string> => {
  if (password.length < 12) throw new Error("La contraseña debe tener al menos 12 caracteres");
  const salt = randomBytes(16).toString("base64url");
  const derived = await derivePassword(password, salt, passwordCost, passwordBlockSize, passwordParallelization);
  return `scrypt$${passwordCost}$${passwordBlockSize}$${passwordParallelization}$${salt}$${derived.toString("base64url")}`;
};

export const verifyPassword = async (password: string, encoded: string): Promise<boolean> => {
  const [algorithm, nValue, rValue, pValue, salt, expectedValue] = encoded.split("$");
  if (algorithm !== "scrypt" || !nValue || !rValue || !pValue || !salt || !expectedValue) return false;
  const derived = await derivePassword(password, salt, Number(nValue), Number(rValue), Number(pValue));
  const expected = Buffer.from(expectedValue, "base64url");
  return expected.length === derived.length && timingSafeEqual(expected, derived);
};

const jwtPart = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
export const authCookieName = "afterstage_session";

const accessTokenTtlSeconds = (): number => {
  const configuredTtl = Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 900);
  return Number.isFinite(configuredTtl) ? Math.max(300, configuredTtl) : 900;
};

export const issueAccessToken = (user: ActiveUser): string => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET no está configurado");
  const now = Math.floor(Date.now() / 1000);
  const ttl = accessTokenTtlSeconds();
  const issuer = process.env.JWT_ISSUER || "afterstage";
  const audience = process.env.JWT_AUDIENCE || "afterstage-web";
  const header = jwtPart({ alg: "HS256", typ: "JWT" });
  const payload = jwtPart({
    sub: user.id,
    roles: user.roles,
    permissions: user.permissions,
    sessionVersion: user.sessionVersion ?? 0,
    jti: randomBytes(24).toString("base64url"),
    iat: now,
    exp: now + ttl,
    iss: issuer,
    aud: audience,
  });
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
};

export const authenticateUser = async (
  identifier: string,
  password: string,
  directory: UserDirectory | undefined = userDirectory,
): Promise<ActiveUser | undefined> => {
  const user = await directory?.findByIdentifier?.(identifier.trim());
  if (!user?.passwordHash) {
    await derivePassword(
      password,
      "afterstage-login-dummy-salt",
      passwordCost,
      passwordBlockSize,
      passwordParallelization,
    );
    return undefined;
  }
  let valid = false;
  try {
    valid = await verifyPassword(password, user.passwordHash);
  } catch {
    valid = false;
  }
  if (!user || user.active === false || !valid) return undefined;
  return {
    id: user.id,
    roles: user.roles,
    permissions: user.permissions,
    active: user.active,
    ...(typeof user.sessionVersion === "number" ? { sessionVersion: user.sessionVersion } : {}),
    ...(user.email ? { email: user.email } : {}),
  };
};

const decodePart = (value: string): unknown => JSON.parse(Buffer.from(value, "base64url").toString("utf8"));

export const actorFromJwt = async (token: string): Promise<Actor | undefined> => {
  const secret = process.env.JWT_SECRET;
  if (!secret) return undefined;
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const header = decodePart(parts[0]!) as { alg?: string; typ?: string };
    const claims = decodePart(parts[1]!) as {
      sub?: unknown;
      exp?: unknown;
      nbf?: unknown;
      iss?: unknown;
      aud?: unknown;
      roles?: unknown;
      permissions?: unknown;
      sessionVersion?: unknown;
      jti?: unknown;
    };
    if (
      header.alg !== "HS256" ||
      header.typ !== "JWT" ||
      typeof claims.sub !== "string" ||
      !claims.sub ||
      typeof claims.jti !== "string" ||
      !claims.jti
    )
      return undefined;
    const expected = createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest("base64url");
    const received = Buffer.from(parts[2]!, "utf8");
    const calculated = Buffer.from(expected, "utf8");
    if (received.length !== calculated.length || !timingSafeEqual(received, calculated)) return undefined;
    const now = Math.floor(Date.now() / 1000);
    const skew = 30;
    if (
      typeof claims.exp !== "number" ||
      claims.exp <= now - skew ||
      (typeof claims.nbf === "number" && claims.nbf > now + skew)
    )
      return undefined;
    const expectedIssuer = process.env.JWT_ISSUER || "afterstage";
    const expectedAudience = process.env.JWT_AUDIENCE || "afterstage-web";
    if (claims.iss !== expectedIssuer) return undefined;
    if (!(claims.aud === expectedAudience || (Array.isArray(claims.aud) && claims.aud.includes(expectedAudience))))
      return undefined;
    let user: ActiveUser | undefined;
    try {
      user = await userDirectory?.findActiveUser(claims.sub);
      if (user) {
        if (!userDirectory?.isSessionRevoked && process.env.NODE_ENV === "production")
          throw new SessionVerificationUnavailable();
        if (userDirectory?.isSessionRevoked && (await userDirectory.isSessionRevoked(user.id, claims.jti)))
          return undefined;
      }
    } catch {
      throw new SessionVerificationUnavailable();
    }
    if (!user || user.active === false) return undefined;
    if ((claims.sessionVersion ?? 0) !== (user.sessionVersion ?? 0)) return undefined;
    if (
      !Array.isArray(claims.roles) ||
      JSON.stringify([...claims.roles].sort()) !== JSON.stringify([...user.roles].sort())
    )
      return undefined;
    if (
      !Array.isArray(claims.permissions) ||
      JSON.stringify([...claims.permissions].sort()) !== JSON.stringify([...user.permissions].sort())
    )
      return undefined;
    return { id: user.id, roles: user.roles, permissions: user.permissions };
  } catch (error) {
    if (error instanceof SessionVerificationUnavailable) throw error;
    return undefined;
  }
};

const cookieValue = (request: Request, name: string): string | undefined => {
  const cookies = request.get("cookie")?.split(";") ?? [];
  const entry = cookies.find((item) => item.trim().startsWith(`${name}=`));
  if (!entry) return undefined;
  const value = entry.slice(entry.indexOf("=") + 1).trim();
  return value ? decodeURIComponent(value) : undefined;
};

const tokenFromRequest = (request: Request): string | undefined => {
  const authorization = request.get("authorization");
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  return bearer ?? cookieValue(request, authCookieName);
};

export const actorFromRequest = async (request: Request): Promise<Actor | undefined> => {
  const token = tokenFromRequest(request);
  return token ? actorFromJwt(token) : undefined;
};

export const correlationIdMiddleware: RequestHandler = (request, response, next) => {
  const received = request.get("x-correlation-id")?.trim();
  const correlationId = received && /^[A-Za-z0-9._:-]{1,128}$/.test(received) ? received : randomUUID();
  (request as Request & { correlationId: string }).correlationId = correlationId;
  response.setHeader("X-Correlation-ID", correlationId);
  next();
};

export const revokeSessionFromRequest = async (request: Request): Promise<void> => {
  const token = tokenFromRequest(request);
  if (!token) return;
  const actor = await actorFromJwt(token);
  if (!actor) return;
  const parts = token.split(".");
  if (parts.length !== 3) return;
  const claims = decodePart(parts[1]!) as { jti?: unknown; exp?: unknown };
  if (typeof claims.jti !== "string" || typeof claims.exp !== "number" || !userDirectory?.revokeSession)
    throw new SessionVerificationUnavailable();
  try {
    await userDirectory.revokeSession(actor.id, claims.jti, new Date(claims.exp * 1000));
  } catch {
    throw new SessionVerificationUnavailable();
  }
};

export const setAuthCookie = (response: Response, token: string): void => {
  response.setHeader(
    "Set-Cookie",
    `${authCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${accessTokenTtlSeconds()}`,
  );
};

export const clearAuthCookie = (response: Response): void => {
  response.setHeader("Set-Cookie", `${authCookieName}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
};

export const requireRole =
  (...roles: Role[]): RequestHandler =>
  async (request, response, next) => {
    const actor = await actorFromRequest(request);
    if (!actor) {
      response.status(401).json({ error: "No autorizado" });
      return;
    }
    if (!actor.roles.some((role) => roles.includes(role))) {
      response.status(403).json({ error: "Permisos insuficientes" });
      return;
    }
    (request as Request & { actor?: Actor }).actor = actor;
    next();
  };

export const hasPermission = (actor: Actor, permission: Permission): boolean =>
  actor.roles.includes("admin") || actor.roles.includes("social") || actor.permissions.includes(permission);

export const requirePermission =
  (...permissions: Permission[]): RequestHandler =>
  async (request, response, next) => {
    const actor = await actorFromRequest(request);
    if (!actor) {
      response.status(401).json({ error: "No autorizado" });
      return;
    }
    if (!permissions.some((permission) => hasPermission(actor, permission))) {
      response.status(403).json({ error: "Permisos insuficientes" });
      return;
    }
    (request as Request & { actor?: Actor }).actor = actor;
    next();
  };

export const audit = async (request: Request, action: string, metadata: Record<string, unknown> = {}) => {
  const file = path.join(process.env.DATA_DIR ?? path.resolve("data"), "audit.jsonl");
  await mkdir(path.dirname(file), { recursive: true });
  const actor = (request as Request & { actor?: Actor }).actor;
  const correlationId = (request as Request & { correlationId?: string }).correlationId;
  const operation = auditQueue.then(async () => {
    const info = await stat(file).catch(() => undefined);
    if (info && info.size > 10 * 1024 * 1024) await rename(file, `${file}.${Date.now()}`).catch(() => undefined);
    await appendFile(
      file,
      `${JSON.stringify({ at: new Date().toISOString(), service: "afterstage-social-manager", correlationId, actor: actor ?? { id: "anonymous", roles: [], permissions: [] }, action, method: request.method, path: request.path, metadata })}\n`,
      "utf8",
    );
  });
  auditQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  await operation;
};
let auditQueue: Promise<void> = Promise.resolve();

export const auditMiddleware: RequestHandler = (request, _response, next) => {
  const response = request.res;
  const original = response?.end;
  if (original) {
    response.end = function (this: typeof response, ...args: Parameters<typeof original>) {
      void audit(request, "http_request", { status: response.statusCode });
      return original.apply(this, args);
    } as typeof original;
  }
  next();
};

export class RateLimiter {
  private readonly hits = new Map<string, { count: number; reset: number }>();
  constructor(
    private readonly limit = Number(process.env.RATE_LIMIT ?? 120),
    private readonly windowMs = 60_000,
  ) {}
  middleware: RequestHandler = (request, response, next) => {
    const key = request.ip ?? "unknown";
    const now = Date.now();
    const current = this.hits.get(key);
    if (this.hits.size > 10_000)
      for (const [storedKey, value] of this.hits) if (value.reset <= now) this.hits.delete(storedKey);
    const item = !current || current.reset <= now ? { count: 0, reset: now + this.windowMs } : current;
    item.count += 1;
    this.hits.set(key, item);
    response.setHeader("X-RateLimit-Limit", this.limit);
    response.setHeader("X-RateLimit-Remaining", Math.max(0, this.limit - item.count));
    if (item.count > this.limit) {
      response.status(429).json({ error: "Demasiadas solicitudes" });
      return;
    }
    next();
  };
}

export const securityHeaders: RequestHandler = (request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(self)");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self' https:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  if (process.env.NODE_ENV === "production" && request.secure)
    response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
};

export const requireSecureTransport: RequestHandler = (request, response, next) => {
  if (process.env.NODE_ENV === "production" && !request.secure) {
    response.status(400).json({ error: "Esta operación requiere una conexión HTTPS" });
    return;
  }
  next();
};
