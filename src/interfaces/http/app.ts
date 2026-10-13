import { mkdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import multer from "multer";
import { ZodError, z } from "zod";
import { ContentManager, DuplicateContentError } from "../../application/content-manager.js";
import { contentStatuses } from "../../domain/content/types.js";
import { PressManager } from "../../application/press-manager.js";
import { DirectoryManager } from "../../application/directory-manager.js";
import { EventsFeed } from "../../infrastructure/integrations/events-feed.js";
import {
  auditMiddleware,
  authenticateUser,
  configureUserDirectory,
  issueAccessToken,
  RateLimiter,
  requireRole,
  requirePermission,
  hasPermission,
  securityHeaders,
  type UserDirectory,
} from "./security.js";
import { schedulerStatus } from "../../application/ops.js";
import { log } from "./logger.js";
import type { DirectoryItem } from "../../domain/directory/types.js";
import { distanceQuery, distanceKm } from "../../domain/location.js";

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
const cdata = (value: string): string => value.replace(/]]>/g, "]]]]><![CDATA[>");
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
  lastVerifiedAt: item.lastVerifiedAt,
  updatedAt: item.updatedAt,
});

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
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(item.seoTitle || item.title)} — Medio Under</title><meta name="description" content="${escapeHtml(description)}"><link rel="canonical" href="${escapeHtml(canonical)}"><meta property="og:title" content="${escapeHtml(item.title)}"><meta property="og:description" content="${escapeHtml(description)}"><meta property="og:type" content="article">${item.assets[0] ? `<meta property="og:image" content="${escapeHtml(item.assets[0].url)}">` : ""}<style>body{background:#f4f0e8;color:#171717;font:18px/1.65 system-ui;margin:0}.wrap{margin:auto;max-width:820px;padding:40px 22px 90px}a{color:inherit}h1{font-size:clamp(48px,8vw,92px);letter-spacing:-.07em;line-height:.92;margin:60px 0 25px}.summary{color:#57534e;font-size:22px}.hero-image{border:2px solid #171717;display:block;margin:45px 0;max-height:620px;object-fit:cover;width:100%}.meta{display:flex;gap:18px;flex-wrap:wrap;font-size:13px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}.body{max-width:680px}.tags{border-top:1px solid #aaa;margin-top:50px;padding-top:18px}.credit{font-size:14px;color:#57534e}.share-bar{display:flex;gap:10px;flex-wrap:wrap;margin:28px 0}.share-button{background:#171717;border:1px solid #171717;color:#fff;cursor:pointer;padding:12px 17px;font:inherit}.share-button.secondary{background:transparent;color:#171717}</style></head><body><main class="wrap"><a href="/">← Medio Under</a><article><h1>${escapeHtml(item.title)}</h1><p class="summary">${escapeHtml(item.summary)}</p><p class="meta">${author}${credit}<span>Publicado ${new Date(item.publishedAt ?? item.updatedAt).toLocaleDateString("es-AR")}</span></p><div class="share-bar"><button class="share-button" data-share="${escapeHtml(item.title)}" data-share-url="${escapeHtml(canonical)}">Compartir desde el celular</button><button class="share-button secondary" data-share-instagram data-share-url="${escapeHtml(canonical)}">Compartir en Instagram</button></div>${image}<div class="body">${paragraphs}</div><p class="tags">${item.tags.map((tag) => `#${escapeHtml(tag)}`).join(" · ")}</p><p class="credit">Fuente: ${escapeHtml(item.source || "Medio Under")}</p></article></main><script src="/share.js"></script></body></html>`;
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
) => {
  const app = express();
  configureUserDirectory(users);
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
  app.use(express.json({ limit: "2mb" }));
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
      service: "medio-under-social-manager",
      startedAt,
      now: new Date().toISOString(),
    }),
  );
  app.get("/ready", (_request, response) =>
    response.json({
      status: "ready",
      mongo: Boolean(process.env.MONGODB_URI),
      smtp: Boolean(process.env.SMTP_HOST),
      meta: Boolean(process.env.META_ACCESS_TOKEN),
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
    }),
  );
  app.get(
    "/api/auth/me",
    requireRole("admin", "editor", "press", "directory", "community", "auditor", "social"),
    (request, response) => response.json({ user: (request as typeof request & { actor?: unknown }).actor }),
  );
  const loginRateLimit = new RateLimiter(10, 60_000).middleware;
  app.post("/api/auth/login", loginRateLimit, async (request, response) => {
    if (!process.env.JWT_SECRET) {
      response.status(503).json({ error: "El login no está configurado" });
      return;
    }
    const input = z
      .object({ identifier: z.string().min(1).max(180), password: z.string().min(1).max(200) })
      .parse(request.body);
    const user = await authenticateUser(input.identifier, input.password);
    if (!user) {
      response.status(401).json({ error: "Credenciales inválidas" });
      return;
    }
    response.json({
      accessToken: issueAccessToken(user),
      user: {
        id: user.id,
        roles: user.roles,
        permissions: user.permissions,
      },
    });
  });
  app.get("/api/public/press-kit", async (_request, response) => {
    const snapshot = await press.snapshot();
    response.json({
      mediaKit: snapshot.mediaKit,
      events: snapshot.events.filter((event) => event.status === "covered"),
      coverages: snapshot.coverages.filter((coverage) => coverage.url),
    });
  });
  app.get("/api/public/content", async (request, response) => {
    const limit = Math.min(100, Math.max(1, Number(request.query.limit ?? 50)));
    const tag = typeof request.query.tag === "string" ? request.query.tag.toLowerCase() : "";
    const items = (await manager.store.list("published"))
      .filter(
        (item) =>
          item.channels.includes("website") && (!tag || item.tags.some((itemTag) => itemTag.toLowerCase() === tag)),
      )
      .slice(0, limit);
    response.json(items.map(publicContent));
  });
  app.get("/api/public/content/:slug", async (request, response) => {
    const item = (await manager.store.list("published")).find(
      (entry) => entry.slug === request.params.slug && entry.channels.includes("website"),
    );
    if (!item) return response.status(404).json({ error: "Contenido no encontrado" });
    const updated = await manager.store.incrementViews(item.id);
    response.json(updated ? publicContent(updated) : publicContent(item));
  });
  app.get("/notas/:slug", async (request, response) => {
    const item = (await manager.store.list("published")).find(
      (entry) => entry.slug === request.params.slug && entry.channels.includes("website"),
    );
    if (!item) return response.status(404).send("Nota no encontrada");
    const updated = await manager.store.incrementViews(item.id);
    response.type("html").send(renderArticle(updated ?? item));
  });
  app.get("/api/public/metrics", async (_request, response) => {
    const items = await manager.store.list("published");
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
      response.json(
        (await directory.list(query, parsedLocation.success ? parsedLocation.data : undefined))
          .filter((item) => item.status === "active")
          .map(publicDirectory),
      );
    },
  );
  app.get("/api/public/events", async (_request, response) => {
    const snapshot = await press.snapshot();
    const local = snapshot.events.filter(
      (event) => event.status === "planned" && (!event.startsAt || Date.parse(event.startsAt) >= Date.now()),
    );
    const external = await eventsFeed.list();
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
    response.json(events);
  });
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
      response.json(items.map(({ contactEmail: _private, ...item }) => item));
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
      .filter((item) => item.channels.includes("website"))
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
        `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Medio Under</title><link>${base}</link><description>Periodismo musical para la escena que hace.</description>${xml}</channel></rss>`,
      );
  });
  app.get("/sitemap.xml", async (_request, response) => {
    const base = (process.env.PUBLIC_BASE_URL ?? "").replace(/\/$/, "");
    const items = (await manager.store.list("published")).filter((item) => item.channels.includes("website"));
    response
      .type("application/xml")
      .send(
        `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${base || "http://localhost:8787"}/</loc></url><url><loc>${base || "http://localhost:8787"}/notas</loc></url><url><loc>${base || "http://localhost:8787"}/agenda</loc></url><url><loc>${base || "http://localhost:8787"}/politica-editorial</loc></url><url><loc>${base || "http://localhost:8787"}/codigo-de-creditos</loc></url>${items.map((item) => `<url><loc>${base}/notas/${encodeURIComponent(item.slug)}</loc><lastmod>${item.updatedAt}</lastmod></url>`).join("")}</urlset>`,
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
  app.use("/api", requireRole("admin", "editor", "press", "directory", "community", "auditor", "social"));
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
  app.patch("/api/content/:id", requireRole("admin", "editor"), async (request, response) =>
    response.json(await manager.update(String(request.params.id), request.body)),
  );
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
