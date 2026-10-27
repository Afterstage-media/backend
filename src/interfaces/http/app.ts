import { mkdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import multer from "multer";
import { ZodError, z } from "zod";
import { ContentManager, DuplicateContentError } from "../../application/content-manager.js";
import { PlatformManager } from "../../application/platform-manager.js";
import { contentStatuses } from "../../domain/content/types.js";
import { PressManager } from "../../application/press-manager.js";
import { DirectoryManager } from "../../application/directory-manager.js";
import { EventsFeed } from "../../infrastructure/integrations/events-feed.js";
import {
  audit,
  auditMiddleware,
  authenticateUser,
  configureUserDirectory,
  decryptAuthSecret,
  getAuthEncryptionPublicKey,
  issueAccessToken,
  setAuthCookie,
  hashPassword,
  RateLimiter,
  requireRole,
  requirePermission,
  requireSecureTransport,
  hasPermission,
  securityHeaders,
  type ManagedUser,
  type Permission,
  type Role,
  type UserDirectory,
} from "./security.js";
import { schedulerStatus } from "../../application/ops.js";
import { log } from "./logger.js";
import type { DirectoryItem } from "../../domain/directory/types.js";
import { distanceQuery, distanceKm } from "../../domain/location.js";
import { MonetizationManager } from "../../application/monetization-manager.js";
import { monetizationStatuses } from "../../domain/monetization/types.js";
import { mountRemoteMcp } from "../mcp/remote.js";
import type { McpOAuthStore } from "../mcp/oauth.js";
import { MEDIA_CONTENT_TYPES, MediaAssetService } from "../../infrastructure/integrations/media-storage.js";
import { MediaQuotaExceededError } from "../../infrastructure/persistence/mongo-media-assets.js";
import type { InstagramConnectionStore } from "../../infrastructure/persistence/instagram-connections.js";
import type { EditorialVoiceRepository } from "../../infrastructure/persistence/editorial-voice-store.js";
import { MailboxManager } from "../../application/mailbox-manager.js";
import { inboundMailSchema, mailReplySchema } from "../../domain/mail/types.js";
import { mailRouteInputSchema, mailRoutePatchSchema } from "../../domain/mail/routing.js";
import type { MailRepository } from "../../infrastructure/persistence/mail-store.js";
import { PressMailer, type Mail } from "../../infrastructure/integrations/mailer.js";
import { insuranceProductLabels, type InsuranceProduct } from "../../domain/platform/types.js";
import {
  exchangeInstagramCode,
  instagramAuthorizationUrl,
  readInstagramOAuthState,
} from "../../infrastructure/integrations/instagram-oauth.js";

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );

const publicSitemapPaths = [
  "/",
  "/notas",
  "/agenda",
  "/como-funciona",
  "/comunidad",
  "/red",
  "/seguros",
  "/marketplace",
  "/traslados",
  "/servicios",
  "/contratar",
  "/colaborador",
  "/politica-editorial",
  "/codigo-de-creditos",
];

const insuranceRecipients = (): string[] =>
  (process.env.INSURANCE_RECIPIENT_EMAIL ?? process.env.INSURANCE_FORWARD_TO ?? "")
    .split(/[;,\s]+/)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

const insuranceProductNames = (coverageTypes: InsuranceProduct[] | undefined, fallback: string): string[] =>
  coverageTypes?.length ? coverageTypes.map((product) => insuranceProductLabels[product]) : fallback ? [fallback] : [];

export const insuranceNotificationText = (item: {
  name: string;
  dni?: string;
  organization: string;
  email: string;
  phone: string;
  coverageType: string;
  coverageTypes?: InsuranceProduct[];
  productDetails?: {
    eventName?: string;
    eventLocation?: string;
    eventDescription?: string;
    apPeopleCount?: number | null;
    apInsuredSumLabel?: string;
    artEmployer?: string;
    artActivity?: string;
    artWorkerCount?: number | null;
    vidaInsuredName?: string;
    vidaInsuredAge?: number | null;
    vidaInsuredSumLabel?: string;
    vidaBeneficiary?: string;
    equipmentDescription?: string;
    equipmentValueLabel?: string;
    equipmentCount?: number | null;
    equipmentSerials?: string;
  };
  startsAt: string | null;
  endsAt: string | null;
  peopleCount: number;
  notes: string;
  eventName?: string;
}) =>
  (() => {
    const details = item.productDetails ?? {};
    const products = insuranceProductNames(item.coverageTypes, item.coverageType);
    const lines = [
      "SOLICITUD DE COTIZACIÓN | AFTERSTAGE",
      "",
      `Asunto sugerido: Solicitud de cotización · ${products.join(" + ") || "Seguro"} · ${item.name}`,
      "",
      "DATOS DEL SOLICITANTE",
      `Nombre y apellido: ${item.name}`,
      `DNI: ${item.dni || "No indicado"}`,
      `Organización: ${item.organization || "No indicada"}`,
      `Email: ${item.email}`,
      `Teléfono: ${item.phone || "No indicado"}`,
      "",
      `PRODUCTOS SOLICITADOS: ${products.join(" + ") || item.coverageType || "No indicado"}`,
      "",
      "DATOS GENERALES DEL EVENTO",
      `Evento: ${details.eventName || item.eventName || "No indicado"}`,
      `Lugar: ${details.eventLocation || "No indicado"}`,
      `Descripción: ${details.eventDescription || "No indicada"}`,
      `Desde: ${item.startsAt || "No indicado"}`,
      `Hasta: ${item.endsAt || "No indicado"}`,
      `Personas involucradas: ${item.peopleCount}`,
      "",
      "DETALLE POR PRODUCTO",
    ];
    if (item.coverageTypes?.includes("ap"))
      lines.push(
        "[ACCIDENTES PERSONALES]",
        `Personas a asegurar: ${details.apPeopleCount ?? item.peopleCount}`,
        `Suma asegurada: ${details.apInsuredSumLabel || "No indicada"}`,
        "",
      );
    if (item.coverageTypes?.includes("art"))
      lines.push(
        "[ART]",
        `Empleador / razón social: ${details.artEmployer || "No indicado"}`,
        `Actividad: ${details.artActivity || "No indicada"}`,
        `Trabajadores: ${details.artWorkerCount ?? "No indicado"}`,
        "",
      );
    if (item.coverageTypes?.includes("vida"))
      lines.push(
        "[SEGURO DE VIDA]",
        `Persona asegurada: ${details.vidaInsuredName || "No indicada"}`,
        `Edad: ${details.vidaInsuredAge ?? "No indicada"}`,
        `Suma asegurada: ${details.vidaInsuredSumLabel || "No indicada"}`,
        `Beneficiario: ${details.vidaBeneficiary || "No indicado"}`,
        "",
      );
    if (item.coverageTypes?.includes("robo_equipos"))
      lines.push(
        "[ROBO DE EQUIPOS]",
        `Equipos: ${details.equipmentDescription || "No indicados"}`,
        `Valor total: ${details.equipmentValueLabel || "No indicado"}`,
        `Cantidad: ${details.equipmentCount ?? "No indicada"}`,
        `Números de serie / inventario: ${details.equipmentSerials || "No indicados"}`,
        "",
      );
    lines.push(
      "DETALLES ADICIONALES",
      item.notes || "Sin detalles adicionales.",
      "",
      "La cotización debe gestionarse manualmente con la compañía. Este mensaje está armado para copiar y pegar.",
    );
    return lines.join("\n");
  })();
const cdata = (value: string): string => value.replace(/]]>/g, "]]]]><![CDATA[>");
const eventScheduleEnd = (event: {
  startsAt?: string | null;
  endsAt?: string | null;
  dates?: string[];
}): number | undefined => {
  const dates = [...(event.dates ?? []), event.startsAt, event.endsAt]
    .filter((date): date is string => Boolean(date))
    .map((date) => Date.parse(date))
    .filter(Number.isFinite);
  return dates.length ? Math.max(...dates) : undefined;
};
const validSignature = async (file: Express.Multer.File): Promise<boolean> => {
  const bytes = await readFile(file.path);
  if (file.mimetype === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (file.mimetype === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (file.mimetype === "image/gif")
    return bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a";
  if (file.mimetype === "image/webp")
    return bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (file.mimetype.startsWith("video/"))
    return bytes.subarray(4, 8).toString("ascii") === "ftyp" || bytes.subarray(0, 4).toString("ascii") === "RIFF";
  return false;
};

const publicContent = (item: Awaited<ReturnType<ContentManager["required"]>>) => ({
  id: item.id,
  slug: item.slug,
  type: item.type,
  title: item.title,
  summary: item.summary,
  body: item.body,
  assets: item.assets.map(({ id, url, mediaType, altText, credit }) => ({
    id,
    url,
    mediaType,
    altText,
    credit,
  })),
  tags: item.tags,
  author: item.author,
  photographer: item.photographer,
  source: item.source,
  seoTitle: item.seoTitle,
  seoDescription: item.seoDescription,
  canonicalUrl: item.canonicalUrl,
  publishedAt: item.publishedAt,
  updatedAt: item.updatedAt,
  viewCount: item.viewCount ?? 0,
});
const publicDirectory = (item: DirectoryItem & { distanceKm?: number }) => ({
  id: item.id,
  kind: item.kind,
  name: item.name,
  aliases: item.aliases,
  description: item.description,
  city: item.city,
  country: item.country,
  latitude: item.latitude,
  longitude: item.longitude,
  distanceKm: item.distanceKm,
  website: item.website,
  socials: item.socials,
  tags: item.tags,
  status: item.status,
  verificationStatus: item.verificationStatus,
  reliabilityScore: item.reliabilityScore,
  reliableVotes: item.reliableVotes ?? 0,
  unreliableVotes: item.unreliableVotes ?? 0,
  lastVerifiedAt: item.lastVerifiedAt,
  updatedAt: item.updatedAt,
});

const parsePublicLimit = (value: unknown, fallback = 50, maximum = 100): number => {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
};

const managedRoles = ["admin", "editor", "press", "directory", "community", "auditor", "social"] as const;
const managedPermissions = ["instagram:read", "instagram:metrics", "instagram:publish"] as const;
const managedUserResponse = (user: ManagedUser) => ({
  id: user.id,
  username: user.username ?? "",
  email: user.email ?? "",
  roles: user.roles,
  permissions: user.permissions,
  active: user.active !== false,
  createdAt: user.createdAt ?? null,
  updatedAt: user.updatedAt ?? null,
  lastLoginAt: user.lastLoginAt ?? null,
});

const includeDemoData = () => process.env.PUBLIC_INCLUDE_DEMO_DATA === "true";
const isDemoContent = (item: Awaited<ReturnType<ContentManager["required"]>>) =>
  !includeDemoData() && (item.source === "seed-demo" || item.tags.some((tag) => tag.toLowerCase() === "demo"));
const isDemoEvent = (event: { name: string; notes?: string }) =>
  !includeDemoData() && (event.notes === "Evento ficticio generado para pruebas." || /^DEMO\s*[—-]/i.test(event.name));

const renderArticle = (item: Awaited<ReturnType<ContentManager["required"]>>): string => {
  const paragraphs = item.body
    .split(/\n{2,}/)
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("");
  const image = item.assets[0]
    ? `<img class="hero-image" src="${escapeHtml(item.assets[0].url)}" alt="${escapeHtml(item.assets[0].altText)}">`
    : "";
  const description = item.seoDescription || item.summary;
  const canonical = item.canonicalUrl || `${process.env.PUBLIC_BASE_URL ?? ""}/notas/${encodeURIComponent(item.slug)}`;
  const author = item.author ? `<span>Por ${escapeHtml(item.author)}</span>` : "";
  const credit = item.photographer ? `<span>Foto: ${escapeHtml(item.photographer)}</span>` : "";
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(item.seoTitle || item.title)} — afterstage</title><meta name="description" content="${escapeHtml(description)}"><link rel="canonical" href="${escapeHtml(canonical)}"><meta property="og:title" content="${escapeHtml(item.title)}"><meta property="og:description" content="${escapeHtml(description)}"><meta property="og:type" content="article">${item.assets[0] ? `<meta property="og:image" content="${escapeHtml(item.assets[0].url)}">` : ""}<style>body{background:#f4f0e8;color:#171717;font:18px/1.65 system-ui;margin:0}.wrap{margin:auto;max-width:820px;padding:40px 22px 90px}a{color:inherit}h1{font-size:clamp(48px,8vw,92px);letter-spacing:-.07em;line-height:.92;margin:60px 0 25px}.summary{color:#57534e;font-size:22px}.hero-image{border:2px solid #171717;display:block;margin:45px 0;max-height:620px;object-fit:cover;width:100%}.meta{display:flex;gap:18px;flex-wrap:wrap;font-size:13px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}.body{max-width:680px}.tags{border-top:1px solid #aaa;margin-top:50px;padding-top:18px}.credit{font-size:14px;color:#57534e}.share-bar{align-items:center;display:flex;gap:12px;flex-wrap:wrap;margin:28px 0}.share-button{background:#171717;border:1px solid #171717;color:#fff;cursor:pointer;padding:10px 14px;font:inherit;font-size:15px;line-height:1.25}.share-button.secondary{background:transparent;border:0;color:#57534e;font-size:14px;padding:8px 0;text-decoration:underline;text-underline-offset:3px}.share-button.secondary:hover,.share-button.secondary:focus-visible{color:#171717}@media(max-width:600px){.share-bar{align-items:flex-start;display:grid;gap:6px}.share-button{justify-self:start}.share-button.secondary{font-size:13px}}</style></head><body><main class="wrap"><a href="/">← afterstage</a><article><h1>${escapeHtml(item.title)}</h1><p class="summary">${escapeHtml(item.summary)}</p><p class="meta">${author}${credit}<span>Publicado ${new Date(item.publishedAt ?? item.updatedAt).toLocaleDateString("es-AR")}</span></p><div class="share-bar"><button class="share-button" type="button" data-share="${escapeHtml(item.title)}" data-share-url="${escapeHtml(canonical)}">Compartir nota ↗</button><button class="share-button secondary" type="button" data-share-instagram data-share-url="${escapeHtml(canonical)}">Copiar copy para Instagram</button></div>${image}<div class="body">${paragraphs}</div><p class="tags">${item.tags.map((tag) => `#${escapeHtml(tag)}`).join(" · ")}</p><p class="credit">Fuente: ${escapeHtml(item.source || "afterstage")}</p></article></main><script src="/share-ux-final-20261021.js"></script></body></html>`;
};

const renderPressKit = (snapshot: Awaited<ReturnType<PressManager["snapshot"]>>): string => {
  const covered = snapshot.events.filter((event) => event.status === "covered");
  const coverages = snapshot.coverages.filter((coverage) => coverage.url);
  const link = (url: string, label: string) =>
    url ? `<a href="${escapeHtml(url)}" rel="noopener">${escapeHtml(label)}</a>` : "";
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dossier de prensa — ${escapeHtml(snapshot.mediaKit.name)}</title><style>body{background:#f4f0e8;color:#171717;font:17px/1.5 system-ui;margin:0}.wrap{margin:auto;max-width:980px;padding:50px 24px 100px}.mark{background:#ff5c47;border:2px solid #171717;display:inline-block;height:20px;margin-right:9px;transform:rotate(-8deg);vertical-align:-3px;width:20px}h1{font-size:clamp(52px,9vw,110px);letter-spacing:-.08em;line-height:.88;margin:60px 0 26px;max-width:900px}h2{font-size:32px;letter-spacing:-.05em;margin-top:70px}.lead{font-size:24px;max-width:720px}.grid{display:grid;gap:16px;grid-template-columns:repeat(3,1fr)}.card{border:1px solid #171717;padding:18px}.card strong{display:block;font-size:32px}.coverage{border-top:1px solid #aaa;padding:17px 0}.coverage a{color:inherit;font-weight:700}.contact{background:#c7f36a;border:1px solid #171717;padding:22px;margin-top:50px}a{color:inherit}@media(max-width:700px){.grid{grid-template-columns:1fr}.lead{font-size:20px}}</style></head><body><main class="wrap"><a href="/" class="brand"><span class="mark"></span>${escapeHtml(snapshot.mediaKit.name)}</a><h1>${escapeHtml(snapshot.mediaKit.tagline)}</h1><p class="lead">${escapeHtml(snapshot.mediaKit.mission)}</p><section class="grid"><div class="card"><strong>${covered.length}</strong>coberturas</div><div class="card"><strong>${coverages.length}</strong>enlaces publicados</div><div class="card"><strong>${snapshot.mediaKit.audience ? "Sí" : "—"}</strong>audiencia definida</div></section><h2>Quiénes somos</h2><p>${escapeHtml(snapshot.mediaKit.team)}</p><h2>Qué hacemos</h2><p>${escapeHtml(snapshot.mediaKit.services)}</p><h2>Archivo de coberturas</h2>${coverages.length ? coverages.map((coverage) => `<div class="coverage">${link(coverage.url, coverage.title)}${coverage.publishedAt ? `<small> · ${new Date(coverage.publishedAt).toLocaleDateString("es-AR")}</small>` : ""}</div>`).join("") : "<p>Aún estamos construyendo nuestro archivo de coberturas.</p>"}<div class="contact"><strong>Contacto de prensa</strong><p>${escapeHtml(snapshot.mediaKit.email)} ${link(snapshot.mediaKit.website, "Sitio web")} ${escapeHtml(snapshot.mediaKit.instagram)}</p></div></main></body></html>`;
};

export const createApp = async (
  manager = new ContentManager(),
  press = new PressManager(),
  eventsFeed: Pick<EventsFeed, "list"> = new EventsFeed(),
  users?: UserDirectory,
  directory = new DirectoryManager(),
  monetization = new MonetizationManager(),
  mcpOAuthStore?: McpOAuthStore,
  instagramConnections?: InstagramConnectionStore,
  editorialVoice?: EditorialVoiceRepository,
  mailbox?: MailRepository,
  mailer?: Pick<PressMailer, "send">,
  media?: MediaAssetService,
  platform = new PlatformManager(),
) => {
  const app = express();
  const outboundMailer = mailer ?? new PressMailer();
  const mailboxManager = mailbox ? new MailboxManager(mailbox, outboundMailer) : undefined;
  const inboundMailbox = mailbox;
  if (users) configureUserDirectory(users);
  const uploadDir = process.env.UPLOAD_DIR ?? path.resolve("uploads");
  const mediaRoot = process.env.MEDIA_ROOT ?? uploadDir;
  await mkdir(uploadDir, { recursive: true });
  await mkdir(mediaRoot, { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({
      destination: mediaRoot,
      filename: (_request, file, callback) => {
        const extensions: Record<string, string> = {
          "image/jpeg": ".jpg",
          "image/png": ".png",
          "image/webp": ".webp",
          "image/gif": ".gif",
          "video/mp4": ".mp4",
          "video/quicktime": ".mov",
          "video/webm": ".webm",
        };
        callback(null, `${randomUUID()}${extensions[file.mimetype] ?? ".bin"}`);
      },
    }),
    limits: { fileSize: 200 * 1024 * 1024, files: 10 },
    fileFilter: (_request, file, callback) =>
      callback(null, /^(image\/(jpeg|png|webp|gif)|video\/(mp4|quicktime|webm))$/.test(file.mimetype)),
  });

  const origins = (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  app.disable("x-powered-by");
  app.set("trust proxy", process.env.TRUST_PROXY === "true" ? 1 : false);
  app.use(securityHeaders);
  app.use(new RateLimiter().middleware);
  app.use(auditMiddleware);
  app.use(cors({ origin: origins.length ? origins : false }));
  app.post(
    "/api/inbound/email",
    express.raw({ type: "application/json", limit: process.env.JSON_BODY_LIMIT ?? "32mb" }),
    async (request, response) => {
      const secret = process.env.INBOUND_EMAIL_WEBHOOK_SECRET;
      const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.from("");
      const signature = request.header("x-afterstage-signature")?.replace(/^sha256=/, "") ?? "";
      const expected = secret ? createHmac("sha256", secret).update(rawBody).digest() : Buffer.alloc(0);
      const received = Buffer.from(signature, "hex");
      if (!secret || received.length !== expected.length || !timingSafeEqual(received, expected)) {
        response.status(401).json({ error: "invalid_signature" });
        return;
      }
      if (!mailboxManager || !inboundMailbox) {
        response.status(503).json({ error: "mailbox_not_configured" });
        return;
      }
      let body: unknown;
      try {
        body = JSON.parse(rawBody.toString("utf8"));
      } catch {
        response.status(400).json({ error: "invalid_json" });
        return;
      }
      const parsed = inboundMailSchema.safeParse(body);
      if (!parsed.success) {
        response.status(400).json({ error: "invalid_inbound_email", details: parsed.error.flatten() });
        return;
      }
      const domain = (process.env.INBOUND_EMAIL_DOMAIN ?? "afterstage.ar").toLowerCase();
      const recipients = [...parsed.data.to, ...parsed.data.cc];
      if (!recipients.some((address) => address.toLowerCase().endsWith(`@${domain}`))) {
        response.status(400).json({ error: "recipient_domain_not_allowed" });
        return;
      }
      try {
        const message = await inboundMailbox.ingestInbound(parsed.data);
        response.status(202).json({ accepted: true, messageId: message.messageId, threadId: message.threadId });
      } catch (error) {
        log("error", "inbound_email_store_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        response.status(503).json({ error: "inbound_email_store_failed" });
      }
    },
  );
  app.get("/api/inbound/email/routing", async (request, response) => {
    const secret = process.env.INBOUND_EMAIL_WEBHOOK_SECRET;
    const received = Buffer.from(request.header("x-afterstage-routing-secret") ?? "", "utf8");
    const expected = Buffer.from(secret ?? "", "utf8");
    if (!secret || received.length !== expected.length || !timingSafeEqual(received, expected)) {
      response.status(401).json({ error: "invalid_routing_secret" });
      return;
    }
    if (!mailboxManager) {
      response.status(503).json({ error: "mailbox_not_configured" });
      return;
    }
    const recipient = String(request.query.recipient ?? "").trim();
    if (!recipient) {
      response.status(400).json({ error: "recipient_required" });
      return;
    }
    const route = await mailboxManager.getRoute(recipient);
    if (!route) {
      response.status(404).json({ error: "mail_route_not_found" });
      return;
    }
    response.json({ route });
  });
  app.use(express.json({ limit: process.env.JSON_BODY_LIMIT ?? "32mb" }));
  if (mcpOAuthStore && users) {
    const publicUrl = process.env.MCP_PUBLIC_URL ?? process.env.PUBLIC_BASE_URL;
    if (publicUrl)
      mountRemoteMcp(app, manager, press, directory, mcpOAuthStore, users, new URL(publicUrl), editorialVoice);
  }
  app.use(
    "/media",
    express.static(mediaRoot, {
      fallthrough: false,
      index: false,
      dotfiles: "deny",
      maxAge: "1d",
    }),
  );
  app.use(express.static(path.resolve("public")));

  const startedAt = new Date().toISOString();
  app.get("/health", (_request, response) =>
    response.json({
      status: "ok",
      service: "afterstage-social-manager",
      startedAt,
      now: new Date().toISOString(),
    }),
  );
  app.get("/ready", (_request, response) =>
    response.json({
      status: "ready",
      mongo: Boolean(process.env.MONGODB_URI),
      ai: Boolean(process.env.AI_API_KEY),
      smtp: Boolean(process.env.SMTP_HOST),
      meta: Boolean(
        process.env.META_ACCESS_TOKEN ||
        (process.env.META_INSTAGRAM_APP_ID &&
          process.env.META_INSTAGRAM_APP_SECRET &&
          process.env.META_TOKEN_ENCRYPTION_KEY),
      ),
    }),
  );
  app.get("/api/ops/status", requireRole("admin"), (_request, response) =>
    response.json({
      scheduler: schedulerStatus(),
      tunnel: {
        configured: Boolean(process.env.CLOUDFLARE_TUNNEL_URL),
        url: process.env.CLOUDFLARE_TUNNEL_URL ?? null,
      },
      persistence: {
        mongoConfigured: Boolean(process.env.MONGODB_URI),
        dataDir: process.env.DATA_DIR ?? "data",
      },
      media: {
        gatewayConfigured: Boolean(media?.configured),
        maxObjectBytes: Number(process.env.MEDIA_MAX_OBJECT_BYTES ?? 5 * 1024 * 1024),
        contentTypes: MEDIA_CONTENT_TYPES,
      },
      ai: {
        configured: Boolean(process.env.AI_API_KEY),
        baseUrl: process.env.AI_BASE_URL ?? "https://api.openai.com/v1",
        model: process.env.AI_MODEL ?? "gpt-5-mini",
      },
    }),
  );
  app.get(
    "/api/auth/me",
    requireRole("admin", "editor", "press", "directory", "community", "auditor", "social"),
    (request, response) => response.json({ user: (request as typeof request & { actor?: unknown }).actor }),
  );
  app.get("/api/auth/public-key", (_request, response) => response.json(getAuthEncryptionPublicKey()));
  const recoveryRateLimit = new RateLimiter(5, 15 * 60_000).middleware;
  app.post("/api/auth/recover", recoveryRateLimit, requireSecureTransport, async (request, response) => {
    const input = z.object({ email: z.string().trim().toLowerCase().email().max(180) }).parse(request.body);
    const genericMessage = "Si la cuenta existe, vas a recibir un enlace para recuperar el acceso.";
    if (
      !process.env.JWT_SECRET ||
      !process.env.PUBLIC_BASE_URL ||
      !users?.findByIdentifier ||
      !users.createPasswordReset
    ) {
      response.status(503).json({ error: "La recuperación de acceso todavía no está configurada" });
      return;
    }
    const user = await users.findByIdentifier(input.email);
    if (!user?.email || !process.env.SMTP_HOST) {
      response.json({ message: genericMessage });
      return;
    }
    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await users.createPasswordReset(user.id, tokenHash, expiresAt);
    const resetUrl = `${process.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/acceso?reset=${encodeURIComponent(token)}`;
    await new PressMailer().send({
      to: user.email,
      subject: "Recuperá tu acceso a Afterstage",
      text: `Recibimos un pedido para cambiar tu contraseña de Afterstage. Abrí este enlace dentro de la próxima hora: ${resetUrl}\n\nSi no fuiste vos, podés ignorar este mensaje.`,
      html: `<p>Recibimos un pedido para cambiar tu contraseña de Afterstage.</p><p><a href="${resetUrl}">Elegir una contraseña nueva</a></p><p>El enlace vence en una hora. Si no fuiste vos, podés ignorar este mensaje.</p>`,
      fromName: "Afterstage",
    });
    response.json({ message: genericMessage });
  });
  app.post("/api/auth/reset", recoveryRateLimit, requireSecureTransport, async (request, response) => {
    const input = z
      .object({
        token: z.string().min(20).max(200),
        keyId: z.string().length(16),
        passwordCiphertext: z.string().min(1).max(4096),
      })
      .parse(request.body);
    if (!process.env.JWT_SECRET || !users?.consumePasswordReset || !users.updateUser) {
      response.status(503).json({ error: "La recuperación de acceso todavía no está configurada" });
      return;
    }
    let password: string;
    try {
      password = decryptAuthSecret(input.passwordCiphertext, input.keyId);
    } catch {
      response.status(400).json({ error: "Credencial inválida" });
      return;
    }
    if (password.length < 12) {
      response.status(400).json({ error: "La contraseña debe tener al menos 12 caracteres" });
      return;
    }
    const reset = await users.consumePasswordReset(createHash("sha256").update(input.token).digest("hex"));
    if (!reset) {
      response.status(400).json({ error: "El enlace venció o ya fue utilizado" });
      return;
    }
    await users.updateUser(reset.userId, { passwordHash: await hashPassword(password) });
    response.json({ message: "Contraseña actualizada" });
  });
  const loginRateLimit = new RateLimiter(10, 60_000).middleware;
  app.post("/api/auth/login", loginRateLimit, requireSecureTransport, async (request, response) => {
    if (!process.env.JWT_SECRET) {
      response.status(503).json({ error: "El login no está configurado" });
      return;
    }
    const input = z
      .object({
        identifier: z.string().min(1).max(180),
        keyId: z.string().length(16),
        passwordCiphertext: z.string().min(1).max(4096),
      })
      .parse(request.body);
    let password: string;
    try {
      password = decryptAuthSecret(input.passwordCiphertext, input.keyId);
    } catch {
      response.status(400).json({ error: "Credencial inválida" });
      return;
    }
    const user = await authenticateUser(input.identifier, password);
    if (!user) {
      response.status(401).json({ error: "Credenciales inválidas" });
      return;
    }
    const accessToken = issueAccessToken(user);
    setAuthCookie(response, accessToken);
    response.json({
      accessToken,
      user: {
        id: user.id,
        roles: user.roles,
        permissions: user.permissions,
      },
    });
  });
  app.post("/api/auth/register", loginRateLimit, requireSecureTransport, async (request, response) => {
    const input = z
      .object({
        email: z.string().trim().toLowerCase().email().max(180),
        keyId: z.string().length(16),
        passwordCiphertext: z.string().min(1).max(4096),
      })
      .parse(request.body);
    if (!process.env.JWT_SECRET || !users?.createCollaborator) {
      response.status(503).json({ error: "El registro no está configurado" });
      return;
    }
    let password: string;
    try {
      password = decryptAuthSecret(input.passwordCiphertext, input.keyId);
    } catch {
      response.status(400).json({ error: "Credencial inválida" });
      return;
    }
    if (password.length < 12) {
      response.status(400).json({ error: "La contraseña debe tener al menos 12 caracteres" });
      return;
    }
    const passwordHash = await hashPassword(password);
    try {
      const user = await users.createCollaborator(input.email, passwordHash);
      const accessToken = issueAccessToken(user);
      setAuthCookie(response, accessToken);
      response.status(201).json({
        accessToken,
        user: { id: user.id, roles: user.roles, permissions: user.permissions },
      });
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        response.status(409).json({ error: "Ya existe una cuenta con ese email" });
        return;
      }
      throw error;
    }
  });
  app.get("/api/admin/users", requireRole("admin"), async (_request, response) => {
    if (!users?.listUsers) {
      response.status(503).json({ error: "La gestión de usuarios no está configurada" });
      return;
    }
    response.json({ users: (await users.listUsers()).map(managedUserResponse) });
  });
  app.post("/api/admin/users", requireRole("admin"), requireSecureTransport, async (request, response) => {
    if (!users?.createUser) {
      response.status(503).json({ error: "La gestión de usuarios no está configurada" });
      return;
    }
    const input = z
      .object({
        username: z
          .string()
          .trim()
          .min(3)
          .max(80)
          .regex(/^[a-zA-Z0-9._-]+$/),
        email: z.string().trim().toLowerCase().email().max(180).or(z.literal("")),
        roles: z.array(z.enum(managedRoles)).min(1).max(managedRoles.length),
        permissions: z.array(z.enum(managedPermissions)).max(managedPermissions.length),
        active: z.boolean().default(true),
        keyId: z.string().length(16),
        passwordCiphertext: z.string().min(1).max(4096),
      })
      .parse(request.body);
    let password: string;
    try {
      password = decryptAuthSecret(input.passwordCiphertext, input.keyId);
    } catch {
      response.status(400).json({ error: "Credencial inválida" });
      return;
    }
    if (password.length < 12) {
      response.status(400).json({ error: "La contraseña debe tener al menos 12 caracteres" });
      return;
    }
    let user: ManagedUser;
    try {
      user = await users.createUser({
        id: randomUUID(),
        username: input.username.toLowerCase(),
        email: input.email,
        passwordHash: await hashPassword(password),
        roles: input.roles as Role[],
        permissions: input.permissions as Permission[],
        active: input.active,
      });
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        response.status(409).json({ error: "Ya existe un usuario con ese nombre o email" });
        return;
      }
      throw error;
    }
    await audit(request, "admin_user_created", { userId: user.id, roles: user.roles });
    response.status(201).json({ user: managedUserResponse(user) });
  });
  app.patch("/api/admin/users/:id", requireRole("admin"), requireSecureTransport, async (request, response) => {
    if (!users?.listUsers || !users.updateUser) {
      response.status(503).json({ error: "La gestión de usuarios no está configurada" });
      return;
    }
    const input = z
      .object({
        username: z
          .string()
          .trim()
          .min(3)
          .max(80)
          .regex(/^[a-zA-Z0-9._-]+$/)
          .optional(),
        email: z.string().trim().toLowerCase().email().max(180).or(z.literal("")).optional(),
        roles: z.array(z.enum(managedRoles)).min(1).max(managedRoles.length).optional(),
        permissions: z.array(z.enum(managedPermissions)).max(managedPermissions.length).optional(),
        active: z.boolean().optional(),
        keyId: z.string().length(16).optional(),
        passwordCiphertext: z.string().min(1).max(4096).optional(),
      })
      .refine((value) => Object.keys(value).some((key) => key !== "keyId"), {
        message: "No hay cambios para guardar",
      })
      .parse(request.body);
    const allUsers = await users.listUsers();
    const current = allUsers.find((user) => user.id === String(request.params.id));
    if (!current) {
      response.status(404).json({ error: "Usuario no encontrado" });
      return;
    }
    const actor = (request as typeof request & { actor?: { id: string } }).actor;
    const nextRoles = input.roles ?? current.roles;
    const nextActive = input.active ?? current.active !== false;
    if (actor?.id === current.id && (!nextActive || !nextRoles.includes("admin"))) {
      response.status(400).json({ error: "No podés quitarte el último acceso de administrador" });
      return;
    }
    if (current.roles.includes("admin") && current.active !== false && (!nextActive || !nextRoles.includes("admin"))) {
      const remainingAdmins = allUsers.some(
        (user) => user.id !== current.id && user.active !== false && user.roles.includes("admin"),
      );
      if (!remainingAdmins) {
        response.status(400).json({ error: "Debe quedar al menos un administrador activo" });
        return;
      }
    }
    let passwordHash: string | undefined;
    if (input.passwordCiphertext) {
      if (!input.keyId) {
        response.status(400).json({ error: "Falta la clave de cifrado" });
        return;
      }
      try {
        passwordHash = await hashPassword(decryptAuthSecret(input.passwordCiphertext, input.keyId));
      } catch {
        response.status(400).json({ error: "Credencial inválida" });
        return;
      }
    }
    let updated: ManagedUser | undefined;
    try {
      updated = await users.updateUser(current.id, {
        ...(input.username ? { username: input.username.toLowerCase() } : {}),
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.roles ? { roles: input.roles as Role[] } : {}),
        ...(input.permissions ? { permissions: input.permissions as Permission[] } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
        ...(passwordHash ? { passwordHash } : {}),
      });
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        response.status(409).json({ error: "Ya existe un usuario con ese nombre o email" });
        return;
      }
      throw error;
    }
    if (!updated) {
      response.status(404).json({ error: "Usuario no encontrado" });
      return;
    }
    await audit(request, "admin_user_updated", { userId: updated.id, fields: Object.keys(input) });
    response.json({ user: managedUserResponse(updated) });
  });
  app.get("/api/public/press-kit", async (_request, response) => {
    const snapshot = await press.snapshot();
    response.json({
      mediaKit: snapshot.mediaKit,
      events: snapshot.events.filter((event) => event.status === "covered"),
      coverages: snapshot.coverages.filter((coverage) => coverage.url),
    });
  });
  app.get("/api/public/monetization/products", (_request, response) => response.json(monetization.listProducts()));
  app.get("/api/public/promotions", async (_request, response) => {
    const items = await monetization.repository.list();
    response.json(
      items
        .filter((item) => ["approved", "fulfilled"].includes(item.status))
        .map(({ customerEmail: _email, notes: _notes, ...item }) => item),
    );
  });
  app.get("/api/public/promotions/:id", async (request, response) => {
    const item = await monetization.repository.get(String(request.params.id));
    if (!item) return response.status(404).json({ error: "Solicitud no encontrada" });
    response.json({
      id: item.id,
      productId: item.productId,
      title: item.title,
      status: item.status,
      paymentUrl: item.paymentUrl,
    });
  });
  app.post("/api/public/promotions", new RateLimiter(5, 60_000).middleware, async (request, response) => {
    const item = await monetization.create(request.body);
    response.status(201).json({
      id: item.id,
      status: item.status,
      paymentUrl: item.paymentUrl,
      paymentPending: item.status === "pending_payment",
      message: item.paymentUrl
        ? "Solicitud creada. Continuá con el pago."
        : "Solicitud recibida. El medio se va a contactar para coordinarla.",
    });
  });
  app.post("/api/payments/mercadopago/webhook", async (request, response) => {
    const paymentId = String(request.body?.data?.id ?? request.query.id ?? "");
    if (!paymentId) return response.status(400).json({ error: "Falta el identificador del pago" });
    await monetization.processPayment(paymentId);
    response.status(200).json({ received: true });
  });
  app.get("/api/public/content", async (request, response) => {
    const limit = Math.min(100, Math.max(1, Number(request.query.limit ?? 50)));
    const tag = typeof request.query.tag === "string" ? request.query.tag.toLowerCase() : "";
    const items = (await manager.store.list("published"))
      .filter(
        (item) =>
          item.channels.includes("website") &&
          !isDemoContent(item) &&
          (!tag || item.tags.some((itemTag) => itemTag.toLowerCase() === tag)),
      )
      .slice(0, limit);
    response.json(items.map(publicContent));
  });
  app.get("/api/public/content/:slug", async (request, response) => {
    const item = (await manager.store.list("published")).find(
      (entry) => entry.slug === request.params.slug && entry.channels.includes("website") && !isDemoContent(entry),
    );
    if (!item) return response.status(404).json({ error: "Contenido no encontrado" });
    const updated = await manager.store.incrementViews(item.id);
    response.json(updated ? publicContent(updated) : publicContent(item));
  });
  app.get("/notas/:slug", async (request, response) => {
    const item = (await manager.store.list("published")).find(
      (entry) => entry.slug === request.params.slug && entry.channels.includes("website") && !isDemoContent(entry),
    );
    if (!item) return response.status(404).send("Nota no encontrada");
    const updated = await manager.store.incrementViews(item.id);
    response.type("html").send(renderArticle(updated ?? item));
  });
  app.get("/api/public/metrics", async (_request, response) => {
    const items = (await manager.store.list("published")).filter((item) => !isDemoContent(item));
    const pressSnapshot = await press.snapshot();
    response.json({
      published: items.length,
      website: items.filter((item) => item.channels.includes("website")).length,
      instagram: items.filter((item) => item.remoteIds.instagram).length,
      views: items.reduce((total, item) => total + (item.viewCount ?? 0), 0),
      tags: [...new Set(items.flatMap((item) => item.tags))].sort(),
      press: {
        events: pressSnapshot.events.length,
        coveredEvents: pressSnapshot.events.filter((event) => event.status === "covered").length,
        accreditations: pressSnapshot.accreditations.length,
        acceptedAccreditations: pressSnapshot.accreditations.filter((item) =>
          ["accepted", "attended", "coverage_sent"].includes(item.status),
        ).length,
        responses: pressSnapshot.accreditations.filter((item) => item.response.trim()).length,
        coverages: pressSnapshot.coverages.length,
      },
    });
  });
  app.get(
    "/api/public/directory",
    requireRole("admin", "editor", "press", "directory", "auditor"),
    async (request, response) => {
      const query = typeof request.query.q === "string" ? request.query.q : "";
      const parsedLocation = distanceQuery.safeParse({
        lat: request.query.lat,
        lng: request.query.lng,
        radiusKm: request.query.radiusKm,
      });
      if (
        (request.query.lat !== undefined || request.query.lng !== undefined || request.query.radiusKm !== undefined) &&
        !parsedLocation.success
      )
        return response.status(400).json({ error: "Ubicación inválida" });
      const limit = parsePublicLimit(request.query.limit);
      response.json(
        (await directory.list(query, parsedLocation.success ? parsedLocation.data : undefined))
          .filter((item) => item.status === "active")
          .slice(0, limit)
          .map(publicDirectory),
      );
    },
  );
  app.get("/api/public/events", async (_request, response) => {
    const snapshot = await press.snapshot();
    const now = Date.now();
    const local = snapshot.events.filter(
      (event) =>
        !isDemoEvent(event) &&
        event.status === "planned" &&
        (eventScheduleEnd(event) === undefined || eventScheduleEnd(event)! >= now),
    );
    const external = (await eventsFeed.list()).filter((event) => !isDemoEvent(event));
    const location = distanceQuery.safeParse({
      lat: _request.query.lat,
      lng: _request.query.lng,
      radiusKm: _request.query.radiusKm,
    });
    if (
      (_request.query.lat !== undefined || _request.query.lng !== undefined || _request.query.radiusKm !== undefined) &&
      !location.success
    ) {
      return response.status(400).json({ error: "Ubicación inválida" });
    }
    const events = [...local, ...external]
      .flatMap((event) => {
        if (!location.success) return [event];
        if (event.latitude == null || event.longitude == null) return [];
        const distance = distanceKm(location.data.lat, location.data.lng, event.latitude, event.longitude);
        return distance <= location.data.radiusKm ? [{ ...event, distanceKm: Math.round(distance * 10) / 10 }] : [];
      })
      .sort((a, b) => (a.startsAt ?? "9999").localeCompare(b.startsAt ?? "9999"));
    response.json(events.slice(0, parsePublicLimit(_request.query.limit)));
  });
  app.get("/api/public/events/:id", async (request, response) => {
    const snapshot = await press.snapshot();
    const local = snapshot.events.find((event) => event.id === request.params.id && !isDemoEvent(event));
    if (local) {
      response.json(local);
      return;
    }
    const external = (await eventsFeed.list()).find((event) => event.id === request.params.id && !isDemoEvent(event));
    if (!external) {
      response.status(404).json({ error: "Evento no encontrado" });
      return;
    }
    response.json(external);
  });
  app.get("/api/public/events/:id/hub", async (request, response) => {
    const snapshot = await press.snapshot();
    const event = snapshot.events.find((item) => item.id === request.params.id && !isDemoEvent(item));
    if (!event) return response.status(404).json({ error: "Evento no encontrado" });
    response.json(await platform.eventHub(event));
  });
  app.get("/api/public/photographers", async (request, response) => {
    const query = typeof request.query.q === "string" ? request.query.q : "";
    const city = typeof request.query.city === "string" ? request.query.city : "";
    response.json((await platform.publicPhotographers(query, city)).slice(0, parsePublicLimit(request.query.limit)));
  });
  app.post("/api/public/photographers", new RateLimiter(5, 60_000).middleware, async (request, response) => {
    const profile = await platform.createPhotographer({ ...request.body, status: "pending" });
    response.status(201).json({
      id: profile.id,
      status: profile.status,
      message: "Recibimos tu perfil. Lo vamos a revisar antes de publicarlo en la red.",
    });
  });
  app.get("/api/public/coverage-requests", async (request, response) => {
    const eventId = typeof request.query.eventId === "string" ? request.query.eventId : undefined;
    response.json((await platform.publicCoverageRequests(eventId)).slice(0, parsePublicLimit(request.query.limit)));
  });
  app.post("/api/public/coverage-requests", new RateLimiter(5, 60_000).middleware, async (request, response) => {
    const snapshot = await press.snapshot();
    if (request.body?.eventId && !snapshot.events.some((event) => event.id === request.body.eventId))
      return response.status(404).json({ error: "Evento no encontrado" });
    const item = await platform.createCoverageRequest({ ...request.body, status: "open" });
    response.status(201).json({ id: item.id, status: item.status, message: "La búsqueda quedó publicada." });
  });
  app.post(
    "/api/public/coverage-requests/:id/applications",
    new RateLimiter(5, 60_000).middleware,
    async (request, response) => {
      const item = await platform.createCoverageApplication({ ...request.body, requestId: String(request.params.id) });
      response.status(201).json({ id: item.id, status: item.status, message: "Recibimos tu postulación." });
    },
  );
  app.post("/api/public/insurance-requests", new RateLimiter(5, 60_000).middleware, async (request, response) => {
    const snapshot = await press.snapshot();
    if (request.body?.eventId && !snapshot.events.some((event) => event.id === request.body.eventId))
      return response.status(404).json({ error: "Evento no encontrado" });
    const requestedProducts = Array.isArray(request.body?.coverageTypes) ? request.body.coverageTypes : [];
    const coverageType = requestedProducts.length
      ? requestedProducts.map((product: InsuranceProduct) => insuranceProductLabels[product] ?? product).join(" + ")
      : String(request.body?.coverageType ?? "");
    const item = await platform.createInsuranceRequest({
      ...request.body,
      coverageType,
      coverageTypes: requestedProducts,
      status: "new",
    });
    const from = (process.env.INSURANCE_FROM_EMAIL ?? "seguros@afterstage.ar").trim().toLowerCase();
    const recipients = insuranceRecipients();
    const eventName = item.eventId ? snapshot.events.find((event) => event.id === item.eventId)?.name : undefined;
    const text = insuranceNotificationText({ ...item, eventName });
    const subject = `Solicitud de cotización · ${item.coverageType} · ${item.name}`;
    let mailThreadId = "";
    let notificationStatus: "sent" | "not_configured" | "failed" = "not_configured";

    if (inboundMailbox) {
      try {
        const inboxMessage = await inboundMailbox.ingestInbound({
          from: item.email,
          deliveredTo: from,
          replyTo: recipients[0],
          to: recipients.length ? recipients : [from],
          cc: [],
          subject,
          text,
          references: [],
        });
        mailThreadId = inboxMessage.threadId;
      } catch (error) {
        log("error", "insurance_inbox_failed", {
          error: error instanceof Error ? error.message : String(error),
          insuranceRequestId: item.id,
        });
      }
    }

    if (recipients.length) {
      try {
        const mail: Mail = {
          from,
          to: recipients.join(", "),
          replyTo: item.email,
          subject,
          text,
          html: `<pre style="font:inherit;white-space:pre-wrap">${escapeHtml(text)}</pre>`,
        };
        await outboundMailer.send(mail);
        notificationStatus = "sent";
      } catch (error) {
        notificationStatus = "failed";
        log("error", "insurance_notification_failed", {
          error: error instanceof Error ? error.message : String(error),
          insuranceRequestId: item.id,
          recipients,
        });
      }
    }

    const updated = await platform.updateInsuranceRequest(item.id, {
      mailThreadId,
      notificationStatus,
      notificationTo: recipients.join(", "),
    });
    const message =
      notificationStatus === "sent"
        ? "Recibimos la consulta y la enviamos al productor."
        : notificationStatus === "failed"
          ? "Recibimos la consulta, pero el aviso por email quedó pendiente de reintento."
          : "Recibimos la consulta; falta configurar el destinatario de seguros.";
    response.status(201).json({
      id: updated?.id ?? item.id,
      status: updated?.status ?? item.status,
      notificationStatus,
      mailThreadId,
      message,
    });
  });
  app.get("/api/public/marketplace", async (request, response) => {
    const category = typeof request.query.category === "string" ? request.query.category : undefined;
    response.json(await platform.publicMarketplace(category));
  });
  app.get("/api/public/events/:id/forum", async (request, response) => {
    const snapshot = await press.snapshot();
    if (!snapshot.events.some((event) => event.id === request.params.id && !isDemoEvent(event)))
      return response.status(404).json({ error: "Evento no encontrado" });
    const hub = await platform.eventHub({ id: String(request.params.id) });
    response.json(hub.threads);
  });
  app.post(
    "/api/public/events/:id/forum/threads",
    new RateLimiter(10, 60_000).middleware,
    async (request, response) => {
      const snapshot = await press.snapshot();
      if (!snapshot.events.some((event) => event.id === request.params.id && !isDemoEvent(event)))
        return response.status(404).json({ error: "Evento no encontrado" });
      const item = await platform.createForumThread({
        ...request.body,
        eventId: String(request.params.id),
        status: "visible",
      });
      response.status(201).json({ id: item.id, message: "Abrimos la conversación." });
    },
  );
  app.post("/api/public/forum/threads/:id/posts", new RateLimiter(10, 60_000).middleware, async (request, response) => {
    const item = await platform.createForumPost({
      ...request.body,
      threadId: String(request.params.id),
      status: "visible",
    });
    response.status(201).json({ id: item.id, message: "Sumamos tu respuesta." });
  });
  app.get("/api/public/events/:id/transport", async (request, response) => {
    const snapshot = await press.snapshot();
    if (!snapshot.events.some((event) => event.id === request.params.id && !isDemoEvent(event)))
      return response.status(404).json({ error: "Evento no encontrado" });
    const platformSnapshot = await platform.snapshot();
    response.json(
      platformSnapshot.transportOffers.filter((item) => item.eventId === request.params.id && item.status === "open"),
    );
  });
  app.post(
    "/api/public/events/:id/transport-requests",
    new RateLimiter(5, 60_000).middleware,
    async (request, response) => {
      const snapshot = await press.snapshot();
      if (!snapshot.events.some((event) => event.id === request.params.id && !isDemoEvent(event)))
        return response.status(404).json({ error: "Evento no encontrado" });
      const item = await platform.createTransportRequest({ ...request.body, eventId: String(request.params.id) });
      response.status(201).json({ id: item.id, status: item.status, message: "Recibimos tu pedido de traslado." });
    },
  );
  const publicSubmissionRateLimit = new RateLimiter(5, 60_000).middleware;
  app.post(
    "/api/public/submissions",
    publicSubmissionRateLimit,
    requireRole("admin", "editor", "community"),
    async (request, response) => {
      const input = z
        .object({
          kind: z.string().min(1).max(120),
          title: z.string().min(3).max(180),
          description: z.string().min(10).max(5000),
          contact: z.string().email(),
        })
        .parse(request.body);
      const autoApprove = process.env.AUTO_APPROVE_COMMUNITY_SUBMISSIONS !== "false";
      let item = await manager.create({
        title: `[Comunidad] ${input.title}`,
        body: input.description,
        summary: input.description.slice(0, 600),
        status: "idea",
        channels: ["website"],
        notes: `Tipo: ${input.kind}\nContacto: ${input.contact}`,
      });
      if (autoApprove) item = await manager.update(item.id, { status: "draft" });
      if (autoApprove) item = await manager.update(item.id, { status: "review" });
      if (autoApprove) item = await manager.update(item.id, { status: "approved" });
      response.status(201).json({
        accepted: true,
        id: item.id,
        message: autoApprove
          ? "La propuesta fue aprobada automáticamente y quedó disponible para edición."
          : "La propuesta quedó en revisión editorial.",
      });
    },
  );
  app.get(
    "/api/public/replacements",
    requireRole("admin", "editor", "press", "community", "social"),
    async (request, response) => {
      const status = typeof request.query.status === "string" ? request.query.status : "open";
      const location = distanceQuery.safeParse({
        lat: request.query.lat,
        lng: request.query.lng,
        radiusKm: request.query.radiusKm,
      });
      if (
        (request.query.lat !== undefined || request.query.lng !== undefined || request.query.radiusKm !== undefined) &&
        !location.success
      )
        return response.status(400).json({ error: "Ubicación inválida" });
      const items = (await press.listReplacementSearches(status))
        .filter((item) => !item.deadlineAt || Date.parse(item.deadlineAt) >= Date.now())
        .flatMap((item) => {
          if (!location.success) return [item];
          if (item.latitude == null || item.longitude == null) return [];
          const distance = distanceKm(location.data.lat, location.data.lng, item.latitude, item.longitude);
          return distance <= location.data.radiusKm ? [{ ...item, distanceKm: Math.round(distance * 10) / 10 }] : [];
        });
      response.json(
        items.slice(0, parsePublicLimit(request.query.limit)).map(({ contactEmail: _private, ...item }) => item),
      );
    },
  );
  app.post(
    "/api/public/replacements/:id/applications",
    new RateLimiter(5, 60_000).middleware,
    requireRole("admin", "editor", "press", "community", "social"),
    async (request, response) => {
      response
        .status(201)
        .json(await press.createReplacementApplication({ ...request.body, searchId: String(request.params.id) }));
    },
  );
  app.get("/rss.xml", async (_request, response) => {
    const base = (process.env.PUBLIC_BASE_URL ?? "").replace(/\/$/, "");
    const items = (await manager.store.list("published"))
      .filter((item) => item.channels.includes("website") && !isDemoContent(item))
      .slice(0, 50);
    const xml = items
      .map(
        (item) =>
          `<item><title><![CDATA[${cdata(item.title)}]]></title><link>${escapeHtml(`${base}/notas/${encodeURIComponent(item.slug)}`)}</link><guid>${escapeHtml(`${base}/notas/${encodeURIComponent(item.slug)}`)}</guid><description><![CDATA[${cdata(item.summary)}]]></description><pubDate>${new Date(item.publishedAt ?? item.updatedAt).toUTCString()}</pubDate></item>`,
      )
      .join("");
    response
      .type("application/rss+xml")
      .send(
        `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>afterstage</title><link>${base}</link><description>Periodismo musical para la escena que hace.</description>${xml}</channel></rss>`,
      );
  });
  app.get("/sitemap.xml", async (_request, response) => {
    const base = (process.env.PUBLIC_BASE_URL ?? "").replace(/\/$/, "");
    const items = (await manager.store.list("published")).filter(
      (item) => item.channels.includes("website") && !isDemoContent(item),
    );
    const origin = base || "http://localhost:8787";
    const staticUrls = publicSitemapPaths.map((route) => `<url><loc>${origin}${route}</loc></url>`).join("");
    const itemUrls = items
      .map(
        (item) =>
          `<url><loc>${origin}/notas/${encodeURIComponent(item.slug)}</loc><lastmod>${item.updatedAt}</lastmod></url>`,
      )
      .join("");
    response
      .type("application/xml")
      .send(
        `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${staticUrls}${itemUrls}</urlset>`,
      );
  });
  app.get("/robots.txt", (_request, response) =>
    response
      .type("text/plain")
      .send(
        `User-agent: *\nAllow: /\nSitemap: ${(process.env.PUBLIC_BASE_URL ?? "http://localhost:8787").replace(/\/$/, "")}/sitemap.xml\n`,
      ),
  );
  app.get("/press-kit", async (_request, response) =>
    response.type("html").send(renderPressKit(await press.snapshot())),
  );

  app.get("/api/integrations/instagram/callback", requireSecureTransport, async (request, response) => {
    const code = typeof request.query.code === "string" ? request.query.code : "";
    const state = typeof request.query.state === "string" ? request.query.state : "";
    const error = typeof request.query.error === "string" ? request.query.error : "";
    if (error) {
      response.status(400).send("La autorización de Instagram fue cancelada.");
      return;
    }
    if (!code || !state) {
      response.status(400).send("Faltan datos de autorización de Instagram.");
      return;
    }
    try {
      const oauthState = readInstagramOAuthState(state);
      if (!instagramConnections) {
        response.status(503).send("La conexión con Instagram no está configurada en Afterstage.");
        return;
      }
      const connection = await exchangeInstagramCode(code);
      await instagramConnections.upsert({ ...connection, connectedByUserId: oauthState.actorId });
      const destination = `${(process.env.PUBLIC_BASE_URL ?? "/").replace(/\/$/, "")}/admin?instagram=connected`;
      response.redirect(destination || "/admin?instagram=connected");
    } catch (oauthError) {
      log("error", "instagram_oauth_failed", {
        error: oauthError instanceof Error ? oauthError.message : String(oauthError),
      });
      response.status(400).send("No se pudo conectar Instagram. Revisá la configuración de Meta e intentá nuevamente.");
    }
  });

  app.use("/api", requireRole("admin", "editor", "press", "directory", "community", "auditor", "social"));
  app.get("/api/mail/threads", requireRole("admin", "editor", "press", "community"), async (_request, response) => {
    if (!mailboxManager) {
      response.status(503).json({ error: "mailbox_not_configured" });
      return;
    }
    response.json({ threads: await mailboxManager.listThreads() });
  });
  app.get("/api/mail/threads/:id", requireRole("admin", "editor", "press", "community"), async (request, response) => {
    if (!mailboxManager) {
      response.status(503).json({ error: "mailbox_not_configured" });
      return;
    }
    const thread = await mailboxManager.getThread(String(request.params.id));
    if (!thread) {
      response.status(404).json({ error: "thread_not_found" });
      return;
    }
    await mailboxManager.markRead(thread.id);
    response.json({ thread: { ...thread, unreadCount: 0 } });
  });
  app.get("/api/mail/routes", requireRole("admin", "editor", "press", "community"), async (_request, response) => {
    if (!mailboxManager) {
      response.status(503).json({ error: "mailbox_not_configured" });
      return;
    }
    response.json({ routes: await mailboxManager.listRoutes() });
  });
  app.post("/api/mail/routes", requireRole("admin", "editor"), requireSecureTransport, async (request, response) => {
    if (!mailboxManager) {
      response.status(503).json({ error: "mailbox_not_configured" });
      return;
    }
    const parsed = mailRouteInputSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "invalid_mail_route", details: parsed.error.flatten() });
      return;
    }
    try {
      response.status(201).json({ route: await mailboxManager.createRoute(parsed.data) });
    } catch (error) {
      const duplicate = (error as { code?: number }).code === 11000;
      response.status(duplicate ? 409 : 400).json({ error: duplicate ? "mail_route_exists" : "invalid_mail_route" });
    }
  });
  app.patch(
    "/api/mail/routes/:address",
    requireRole("admin", "editor"),
    requireSecureTransport,
    async (request, response) => {
      if (!mailboxManager) {
        response.status(503).json({ error: "mailbox_not_configured" });
        return;
      }
      const parsed = mailRoutePatchSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: "invalid_mail_route", details: parsed.error.flatten() });
        return;
      }
      try {
        const route = await mailboxManager.updateRoute(decodeURIComponent(String(request.params.address)), parsed.data);
        if (!route) {
          response.status(404).json({ error: "mail_route_not_found" });
          return;
        }
        response.json({ route });
      } catch {
        response.status(400).json({ error: "invalid_mail_route" });
      }
    },
  );
  app.delete(
    "/api/mail/routes/:address",
    requireRole("admin", "editor"),
    requireSecureTransport,
    async (request, response) => {
      if (!mailboxManager) {
        response.status(503).json({ error: "mailbox_not_configured" });
        return;
      }
      const deleted = await mailboxManager.deleteRoute(decodeURIComponent(String(request.params.address)));
      if (!deleted) {
        response.status(404).json({ error: "mail_route_not_found" });
        return;
      }
      response.status(204).end();
    },
  );
  app.post(
    "/api/mail/threads/:id/reply",
    requireRole("admin", "editor", "press", "community"),
    requireSecureTransport,
    async (request, response) => {
      if (!mailboxManager) {
        response.status(503).json({ error: "mailbox_not_configured" });
        return;
      }
      const parsed = mailReplySchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: "invalid_reply", details: parsed.error.flatten() });
        return;
      }
      try {
        const message = await mailboxManager.reply(String(request.params.id), parsed.data);
        response.status(201).json({ message });
      } catch (error) {
        log("error", "mail_reply_failed", {
          error: error instanceof Error ? error.message : String(error),
          threadId: String(request.params.id),
        });
        const status = error instanceof Error && error.message === "Conversación no encontrada" ? 404 : 502;
        response.status(status).json({ error: status === 404 ? "thread_not_found" : "mail_reply_failed" });
      }
    },
  );
  app.get("/api/integrations/instagram", requirePermission("instagram:read"), async (_request, response) => {
    if (!instagramConnections) {
      response.status(503).json({ error: "La conexión con Instagram no está configurada" });
      return;
    }
    response.json({ connections: await instagramConnections.list() });
  });
  app.get(
    "/api/integrations/instagram/connect",
    requireRole("admin", "social"),
    requireSecureTransport,
    (request, response) => {
      const actor = (request as typeof request & { actor?: { id: string } }).actor;
      if (!instagramConnections) {
        response.status(503).json({ error: "La conexión con Instagram no está configurada" });
        return;
      }
      if (!actor) {
        response.status(401).json({ error: "No autorizado" });
        return;
      }
      response.redirect(instagramAuthorizationUrl(actor.id));
    },
  );
  app.delete(
    "/api/integrations/instagram/:accountId",
    requireRole("admin", "social"),
    requireSecureTransport,
    async (request, response) => {
      if (!instagramConnections) {
        response.status(503).json({ error: "La conexión con Instagram no está configurada" });
        return;
      }
      const accountId = z.string().regex(/^\d+$/).parse(request.params.accountId);
      const removed = await instagramConnections.remove(accountId);
      response.status(removed ? 204 : 404).end();
    },
  );
  app.get(
    "/api/account/ai-access",
    requireRole("admin", "editor", "press", "directory", "community", "auditor", "social"),
    async (request, response) => {
      if (!mcpOAuthStore) {
        response.status(503).json({ error: "La gestión de accesos de IA no está configurada" });
        return;
      }
      const actor = (request as typeof request & { actor?: { id: string } }).actor;
      if (!actor) {
        response.status(401).json({ error: "No autorizado" });
        return;
      }
      const grants = await mcpOAuthStore.listAccessGrants(actor.id);
      response.json(
        await Promise.all(
          grants.map(async (grant) => {
            const client = await mcpOAuthStore.getClient(grant.clientId);
            return {
              id: grant.id,
              clientId: grant.clientId,
              application: client?.client_name ?? grant.clientId,
              scopes: grant.scopes,
              issuedAt: grant.issuedAt ?? null,
              expiresAt: grant.expiresAt,
            };
          }),
        ),
      );
    },
  );
  app.delete(
    "/api/account/ai-access/:grantId",
    requireRole("admin", "editor", "press", "directory", "community", "auditor", "social"),
    async (request, response) => {
      if (!mcpOAuthStore) {
        response.status(503).json({ error: "La gestión de accesos de IA no está configurada" });
        return;
      }
      const actor = (request as typeof request & { actor?: { id: string } }).actor;
      if (!actor) {
        response.status(401).json({ error: "No autorizado" });
        return;
      }
      const grantId = z.string().uuid().parse(request.params.grantId);
      const revoked = await mcpOAuthStore.revokeAccessGrant(actor.id, grantId);
      response.status(revoked ? 204 : 404).end();
    },
  );
  app.get("/api/monetization/promotions", requireRole("admin", "editor"), async (request, response) => {
    const status =
      typeof request.query.status === "string" && monetizationStatuses.includes(request.query.status as never)
        ? (request.query.status as (typeof monetizationStatuses)[number])
        : undefined;
    response.json(await monetization.repository.list(status));
  });
  app.patch("/api/monetization/promotions/:id", requireRole("admin", "editor"), async (request, response) =>
    response.json(await monetization.update(String(request.params.id), request.body)),
  );
  app.get("/api/content", requireRole("admin", "editor", "auditor"), async (request, response) => {
    const status = z.enum(contentStatuses).optional().parse(request.query.status);
    const query = typeof request.query.q === "string" ? request.query.q : "";
    response.json(await manager.search(query, status));
  });
  app.post("/api/content/duplicates", requireRole("admin", "editor", "auditor"), async (request, response) =>
    response.json(
      await manager.findDuplicates(
        request.body,
        typeof request.body?.excludeId === "string" ? request.body.excludeId : undefined,
      ),
    ),
  );
  app.get("/api/content/:id", requireRole("admin", "editor", "auditor"), async (request, response) =>
    response.json(await manager.required(String(request.params.id))),
  );
  app.post("/api/content/:id/metrics/instagram", requirePermission("instagram:metrics"), async (request, response) => {
    const input = z.object({ dryRun: z.boolean().default(false) }).parse(request.body ?? {});
    response.json(await manager.refreshInstagramMetrics(String(request.params.id), input.dryRun));
  });
  app.get("/api/metrics/instagram", requirePermission("instagram:metrics"), async (_request, response) =>
    response.json(await manager.instagramMetrics()),
  );
  app.post("/api/content", requireRole("admin", "editor"), async (request, response) =>
    response.status(201).json(await manager.create(request.body)),
  );
  app.post("/api/content/with-ai", requireRole("admin", "editor"), async (request, response) =>
    response
      .status(201)
      .json(
        await manager.createNoteWithAi(
          request.body,
          (request as typeof request & { actor?: import("./security.js").Actor }).actor?.id ?? "http",
        ),
      ),
  );
  app.patch("/api/content/:id", requireRole("admin", "editor"), async (request, response) => {
    const contentId = String(request.params.id);
    const updated = await manager.update(contentId, request.body);
    if (updated && media && Array.isArray(request.body?.assets))
      await media.syncContentAssets(contentId, updated.assets);
    response.json(updated);
  });
  app.delete("/api/content/:id", requireRole("admin", "editor"), async (request, response) => {
    const removed = await manager.store.remove(String(request.params.id));
    response.status(removed ? 204 : 404).end();
  });
  app.post("/api/content/:id/generate", requireRole("admin", "editor"), async (request, response) => {
    const input = z
      .object({
        kind: z.enum(["full_article", "social_copy", "improve"]),
        instructions: z.string().max(2000).default(""),
      })
      .parse(request.body);
    response.json(await manager.generate(String(request.params.id), input.kind, input.instructions));
  });
  app.post("/api/content/:id/publish", requireRole("admin", "editor", "social"), async (request, response) => {
    const input = z.object({ dryRun: z.boolean().default(false) }).parse(request.body ?? {});
    const current = await manager.required(String(request.params.id));
    const actor = (request as typeof request & { actor?: import("./security.js").Actor }).actor;
    if (current.channels.includes("instagram") && (!actor || !hasPermission(actor, "instagram:publish"))) {
      response.status(403).json({ error: "Se requiere el permiso instagram:publish" });
      return;
    }
    response.json(await manager.publish(String(request.params.id), input.dryRun));
  });
  app.post("/api/assets/grants", requireRole("admin", "editor"), async (request, response) => {
    if (!media?.configured) {
      response.status(503).json({ error: "El almacenamiento R2 no está configurado" });
      return;
    }
    const input = z
      .object({
        contentId: z.string().uuid(),
        files: z
          .array(
            z.object({
              name: z.string().trim().min(1).max(255),
              contentType: z.enum(MEDIA_CONTENT_TYPES),
              size: z
                .number()
                .int()
                .positive()
                .max(Number(process.env.MEDIA_MAX_OBJECT_BYTES ?? 5 * 1024 * 1024)),
            }),
          )
          .min(1)
          .max(10),
      })
      .parse(request.body);
    await manager.required(input.contentId);
    try {
      response.status(201).json({ grants: await media.createUploadGrants(input.contentId, input.files) });
    } catch (error) {
      if (error instanceof MediaQuotaExceededError) {
        response.status(507).json({ error: error.message });
        return;
      }
      throw error;
    }
  });
  app.post("/api/assets/:id/complete", requireRole("admin", "editor"), async (request, response) => {
    if (!media?.configured) {
      response.status(503).json({ error: "El almacenamiento R2 no está configurado" });
      return;
    }
    response.json(await media.completeUpload(String(request.params.id)));
  });
  app.delete("/api/assets/:id", requireRole("admin", "editor"), async (request, response) => {
    if (!media?.configured) {
      response.status(503).json({ error: "El almacenamiento R2 no está configurado" });
      return;
    }
    await media.removeAsset(String(request.params.id));
    response.status(204).end();
  });
  app.post("/api/assets/maintenance", requireRole("admin"), async (_request, response) => {
    if (!media?.configured) {
      response.status(503).json({ error: "El almacenamiento R2 no está configurado" });
      return;
    }
    const cleaned = await media.cleanup();
    const reconciliation = await media.reconcile();
    response.json({ cleaned, reconciliation });
  });
  app.post("/api/content/:id/repost/instagram", requireRole("admin", "editor", "social"), async (request, response) => {
    const input = z.object({ dryRun: z.boolean().default(false) }).parse(request.body ?? {});
    const current = await manager.required(String(request.params.id));
    const actor = (request as typeof request & { actor?: import("./security.js").Actor }).actor;
    if (!actor || !hasPermission(actor, "instagram:publish")) {
      response.status(403).json({ error: "Se requiere el permiso instagram:publish" });
      return;
    }
    if (!current.channels.includes("instagram")) {
      response.status(400).json({ error: "La nota no tiene Instagram entre sus canales" });
      return;
    }
    response.json(await manager.repostInstagram(String(request.params.id), input.dryRun));
  });
  app.post("/api/assets", requireRole("admin", "editor"), upload.array("images", 10), async (request, response) => {
    const uploaded = request.files as Express.Multer.File[];
    if (!uploaded?.length) throw new Error("Se requiere al menos un archivo");
    try {
      await Promise.all(
        uploaded.map(async (file) => {
          if (!(await validSignature(file))) throw new Error("El archivo no coincide con su tipo MIME declarado");
        }),
      );
    } catch (error) {
      await Promise.all(uploaded.map((file) => unlink(file.path).catch(() => undefined)));
      throw error;
    }
    const publicBase = (
      process.env.CLOUDFLARE_TUNNEL_URL ??
      process.env.PUBLIC_MEDIA_BASE_URL ??
      process.env.PUBLIC_BASE_URL ??
      `${request.protocol}://${request.get("host")}`
    ).replace(/\/$/, "");
    const files = uploaded.map((file) => ({
      id: randomUUID(),
      url: `${publicBase}/media/${encodeURIComponent(file.filename)}`,
      localPath: file.filename,
      mediaType: file.mimetype.startsWith("video/") ? "video" : "image",
      altText: "",
      credit: "",
    }));
    response.status(201).json(files);
  });

  app.get(
    "/api/directory",
    requireRole("admin", "editor", "press", "directory", "auditor"),
    async (request, response) => {
      const parsedLocation = distanceQuery.safeParse({
        lat: request.query.lat,
        lng: request.query.lng,
        radiusKm: request.query.radiusKm,
      });
      if (
        (request.query.lat !== undefined || request.query.lng !== undefined || request.query.radiusKm !== undefined) &&
        !parsedLocation.success
      )
        return response.status(400).json({ error: "Ubicación inválida" });
      return response.json(
        await directory.list(
          typeof request.query.q === "string" ? request.query.q : "",
          parsedLocation.success ? parsedLocation.data : undefined,
        ),
      );
    },
  );
  app.get(
    "/api/directory/:id",
    requireRole("admin", "editor", "press", "directory", "auditor"),
    async (request, response) => response.json(await directory.get(String(request.params.id))),
  );
  app.post(
    "/api/directory/:id/vote",
    requireRole("admin", "editor", "press", "directory", "auditor"),
    async (request, response) => response.json(await directory.vote(String(request.params.id), request.body)),
  );
  app.post("/api/directory", requireRole("admin", "editor", "press", "directory"), async (request, response) =>
    response.status(201).json(await directory.create(request.body)),
  );
  app.patch("/api/directory/:id", requireRole("admin", "editor", "press", "directory"), async (request, response) =>
    response.json(await directory.update(String(request.params.id), request.body)),
  );
  app.post(
    "/api/directory/:id/verification",
    requireRole("admin", "editor", "press", "directory"),
    async (request, response) =>
      response.json(
        await directory.verify(
          String(request.params.id),
          request.body,
          (request as typeof request & { actor?: { id: string } }).actor?.id ?? "unknown",
        ),
      ),
  );
  app.delete("/api/directory/:id", requireRole("admin", "editor"), async (request, response) =>
    response.status((await directory.remove(String(request.params.id))) ? 204 : 404).end(),
  );

  app.get("/api/press/snapshot", requireRole("admin", "press", "auditor"), async (_request, response) =>
    response.json(await press.snapshot()),
  );
  app.post("/api/press/events", requireRole("admin", "press"), async (request, response) =>
    response.status(201).json(await press.createEvent(request.body)),
  );
  app.patch("/api/press/events/:id", requireRole("admin", "press"), async (request, response) =>
    response.json(await press.updateEvent(String(request.params.id), request.body)),
  );
  app.delete("/api/press/events/:id", requireRole("admin", "press"), async (request, response) =>
    response.status((await press.remove("events", String(request.params.id))) ? 204 : 404).end(),
  );
  app.post("/api/press/contacts", requireRole("admin", "press"), async (request, response) =>
    response.status(201).json(await press.createContact(request.body)),
  );
  app.patch("/api/press/contacts/:id", requireRole("admin", "press"), async (request, response) =>
    response.json(await press.updateContact(String(request.params.id), request.body)),
  );
  app.delete("/api/press/contacts/:id", requireRole("admin", "press"), async (request, response) =>
    response.status((await press.remove("contacts", String(request.params.id))) ? 204 : 404).end(),
  );
  app.post("/api/press/accreditations", requireRole("admin", "press"), async (request, response) =>
    response.status(201).json(await press.createAccreditation(request.body)),
  );
  app.patch("/api/press/accreditations/:id", requireRole("admin", "press"), async (request, response) =>
    response.json(await press.updateAccreditation(String(request.params.id), request.body)),
  );
  app.post("/api/press/accreditations/:id/send", requireRole("admin", "press"), async (request, response) =>
    response.json(
      await press.sendAccreditation(
        String(request.params.id),
        z.object({ dryRun: z.boolean().default(true) }).parse(request.body ?? {}).dryRun,
      ),
    ),
  );
  app.post("/api/press/followups/run", requireRole("admin", "press"), async (request, response) =>
    response.json(
      await press.sendDueFollowups(z.object({ dryRun: z.boolean().default(true) }).parse(request.body ?? {}).dryRun),
    ),
  );
  app.delete("/api/press/accreditations/:id", requireRole("admin", "press"), async (request, response) =>
    response.status((await press.remove("accreditations", String(request.params.id))) ? 204 : 404).end(),
  );
  app.post("/api/press/coverages", requireRole("admin", "press"), async (request, response) =>
    response.status(201).json(await press.createCoverage(request.body)),
  );
  app.patch("/api/press/coverages/:id", requireRole("admin", "press"), async (request, response) =>
    response.json(await press.updateCoverage(String(request.params.id), request.body)),
  );
  app.delete("/api/press/coverages/:id", requireRole("admin", "press"), async (request, response) =>
    response.status((await press.remove("coverages", String(request.params.id))) ? 204 : 404).end(),
  );
  app.get("/api/press/replacements", requireRole("admin", "press", "auditor"), async (request, response) =>
    response.json(
      await press.listReplacementSearches(typeof request.query.status === "string" ? request.query.status : undefined),
    ),
  );
  app.post("/api/press/replacements", requireRole("admin", "press"), async (request, response) =>
    response.status(201).json(await press.createReplacementSearch(request.body)),
  );
  app.patch("/api/press/replacements/:id", requireRole("admin", "press"), async (request, response) =>
    response.json(await press.updateReplacementSearch(String(request.params.id), request.body)),
  );
  app.delete("/api/press/replacements/:id", requireRole("admin", "press"), async (request, response) =>
    response.status((await press.remove("replacementSearches", String(request.params.id))) ? 204 : 404).end(),
  );
  app.get(
    "/api/press/replacements/:id/applications",
    requireRole("admin", "press", "auditor"),
    async (request, response) => response.json(await press.listReplacementApplications(String(request.params.id))),
  );
  app.post("/api/press/replacement-applications/:id/assign", requireRole("admin", "press"), async (request, response) =>
    response.json(
      await press.assignReplacementApplication(
        String(request.params.id),
        z.object({ dryRun: z.boolean().default(true) }).parse(request.body ?? {}).dryRun,
      ),
    ),
  );
  app.get("/api/press/media-kit", requireRole("admin", "press"), async (_request, response) =>
    response.json((await press.snapshot()).mediaKit),
  );
  app.patch("/api/press/media-kit", requireRole("admin", "press"), async (request, response) =>
    response.json(await press.updateMediaKit(request.body)),
  );

  app.get(
    "/api/platform/snapshot",
    requireRole("admin", "editor", "press", "community", "auditor"),
    async (_request, response) => response.json(await platform.snapshot()),
  );
  app.patch("/api/platform/photographers/:id", requireRole("admin", "editor", "directory"), async (request, response) =>
    response.json(await platform.updatePhotographer(String(request.params.id), request.body)),
  );
  app.patch(
    "/api/platform/coverage-requests/:id",
    requireRole("admin", "editor", "press", "community"),
    async (request, response) =>
      response.json(await platform.updateCoverageRequest(String(request.params.id), request.body)),
  );
  app.patch(
    "/api/platform/coverage-applications/:id",
    requireRole("admin", "editor", "press", "community"),
    async (request, response) =>
      response.json(await platform.updateCoverageApplication(String(request.params.id), request.body)),
  );
  app.post("/api/platform/transport-offers", requireRole("admin", "editor", "community"), async (request, response) =>
    response.status(201).json(await platform.createTransportOffer(request.body)),
  );
  app.patch(
    "/api/platform/transport-offers/:id",
    requireRole("admin", "editor", "community"),
    async (request, response) =>
      response.json(await platform.updateTransportOffer(String(request.params.id), request.body)),
  );
  app.patch(
    "/api/platform/transport-requests/:id",
    requireRole("admin", "editor", "community"),
    async (request, response) =>
      response.json(await platform.updateTransportRequest(String(request.params.id), request.body)),
  );
  app.patch(
    "/api/platform/insurance-requests/:id",
    requireRole("admin", "editor", "press", "community"),
    async (request, response) =>
      response.json(await platform.updateInsuranceRequest(String(request.params.id), request.body)),
  );
  app.post(
    "/api/platform/insurance-requests/:id/renew",
    requireRole("admin", "editor", "press", "community"),
    async (request, response) => {
      const item = await platform.renewInsuranceRequest(String(request.params.id));
      if (!item) {
        response.status(404).json({ error: "insurance_request_not_found" });
        return;
      }
      response.status(201).json({ item });
    },
  );
  app.patch("/api/platform/forum/threads/:id", requireRole("admin", "editor", "community"), async (request, response) =>
    response.json(await platform.updateForumThread(String(request.params.id), request.body)),
  );
  app.patch("/api/platform/forum/posts/:id", requireRole("admin", "editor", "community"), async (request, response) =>
    response.json(await platform.updateForumPost(String(request.params.id), request.body)),
  );
  app.post("/api/platform/marketplace", requireRole("admin", "editor"), async (request, response) =>
    response.status(201).json(await platform.createMarketplaceListing(request.body)),
  );
  app.patch("/api/platform/marketplace/:id", requireRole("admin", "editor"), async (request, response) =>
    response.json(await platform.updateMarketplaceListing(String(request.params.id), request.body)),
  );

  const errors: ErrorRequestHandler = (error, _request, response, _next) => {
    const status =
      error instanceof DuplicateContentError
        ? 409
        : error instanceof ZodError
          ? 400
          : /no encontrado/i.test(error.message)
            ? 404
            : 422;
    log("error", "request_failed", {
      status,
      error: error instanceof Error ? error.message : String(error),
    });
    const production = process.env.NODE_ENV === "production";
    response.status(status).json({
      error: production
        ? status === 400
          ? "Solicitud inválida"
          : status === 404
            ? "Recurso no encontrado"
            : "No se pudo procesar la solicitud"
        : error.message,
      details: production ? undefined : error instanceof ZodError ? error.issues : undefined,
    });
  };
  app.use(errors);
  return app;
};
