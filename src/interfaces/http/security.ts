import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler } from "express";

export type Role = "admin" | "editor" | "press" | "directory" | "community" | "auditor" | "social";
export const permissionNames = ["instagram:read", "instagram:metrics", "instagram:publish"] as const;
export type Permission = (typeof permissionNames)[number];
const roleNames: Role[] = ["admin", "editor", "press", "directory", "community", "auditor", "social"];
export type Actor = { id: string; roles: Role[]; permissions: Permission[] };

type ConfiguredUser = { token: string; id?: string; roles: Role[]; permissions: Permission[] };
export type ActiveUser = { id: string; roles: Role[]; permissions: Permission[]; active?: boolean };
export type UserDirectory = {
  findActiveUser: (id: string) => Promise<ActiveUser | undefined>;
  findByIdentifier?: (identifier: string) => Promise<(ActiveUser & { passwordHash?: string }) | undefined>;
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

export const configureUserDirectory = (directory?: UserDirectory) => {
  userDirectory = directory;
};

const equal = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
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

export const issueAccessToken = (user: ActiveUser): string => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET no está configurado");
  const now = Math.floor(Date.now() / 1000);
  const configuredTtl = Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 900);
  const ttl = Number.isFinite(configuredTtl) ? Math.max(300, configuredTtl) : 900;
  const header = jwtPart({ alg: "HS256", typ: "JWT" });
  const payload = jwtPart({
    sub: user.id,
    roles: user.roles,
    permissions: user.permissions,
    iat: now,
    exp: now + ttl,
    ...(process.env.JWT_ISSUER ? { iss: process.env.JWT_ISSUER } : {}),
    ...(process.env.JWT_AUDIENCE ? { aud: process.env.JWT_AUDIENCE } : {}),
  });
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
};

export const authenticateUser = async (identifier: string, password: string): Promise<ActiveUser | undefined> => {
  const user = await userDirectory?.findByIdentifier?.(identifier.trim());
  if (!user?.passwordHash) {
    await derivePassword(
      password,
      "medio-under-login-dummy-salt",
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
  };
};

const users = (): ConfiguredUser[] => {
  try {
    const parsed = JSON.parse(process.env.AUTH_USERS_JSON ?? "[]") as ConfiguredUser[];
    if (Array.isArray(parsed))
      return parsed.filter(
        (item) =>
          item?.token &&
          Array.isArray(item.roles) &&
          item.roles.length > 0 &&
          item.roles.every((role) => roleNames.includes(role)) &&
          Array.isArray(item.permissions) &&
          item.permissions.every((permission) => permissionNames.includes(permission)),
      );
  } catch {
    /* configuration errors are reported by the empty set */
  }
  return [];
};

export const actorFromRequest = (request: Request): Actor | undefined => {
  const token = request.get("authorization")?.replace(/^Bearer\s+/i, "") ?? request.get("x-api-key") ?? "";
  const configured = users();
  const fallback: ConfiguredUser[] = process.env.ADMIN_TOKEN
    ? [
        {
          token: process.env.ADMIN_TOKEN,
          id: "admin",
          roles: ["admin"],
          permissions: ["instagram:read", "instagram:metrics", "instagram:publish"],
        },
      ]
    : [];
  const found = [...configured, ...fallback].find((item) => equal(token, item.token));
  return found
    ? {
        id: found.id ?? found.roles[0]!,
        roles: found.roles,
        permissions: found.permissions,
      }
    : undefined;
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
    };
    if (header.alg !== "HS256" || header.typ !== "JWT" || typeof claims.sub !== "string" || !claims.sub)
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
    if (process.env.JWT_ISSUER && claims.iss !== process.env.JWT_ISSUER) return undefined;
    if (
      process.env.JWT_AUDIENCE &&
      !(
        claims.aud === process.env.JWT_AUDIENCE ||
        (Array.isArray(claims.aud) && claims.aud.includes(process.env.JWT_AUDIENCE))
      )
    )
      return undefined;
    const user = await userDirectory?.findActiveUser(claims.sub);
    if (!user || user.active === false) return undefined;
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
  } catch {
    return undefined;
  }
};

export const requireRole =
  (...roles: Role[]): RequestHandler =>
  async (request, response, next) => {
    const authorization = request.get("authorization");
    const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    const actor = bearer?.split(".").length === 3 ? await actorFromJwt(bearer) : actorFromRequest(request);
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
    const authorization = request.get("authorization");
    const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    const actor = bearer?.split(".").length === 3 ? await actorFromJwt(bearer) : actorFromRequest(request);
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
  const operation = auditQueue.then(async () => {
    const info = await stat(file).catch(() => undefined);
    if (info && info.size > 10 * 1024 * 1024) await rename(file, `${file}.${Date.now()}`).catch(() => undefined);
    await appendFile(
      file,
      `${JSON.stringify({ at: new Date().toISOString(), actor: actor ?? { id: "anonymous", roles: [], permissions: [] }, action, method: request.method, path: request.path, ip: request.ip, metadata })}\n`,
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
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' https:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  if (process.env.NODE_ENV === "production" && request.secure)
    response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
};
