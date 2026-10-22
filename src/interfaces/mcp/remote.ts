import cors from "cors";
import express, { type Express } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import {
  createOAuthMetadata,
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { OAuthError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { z } from "zod";
import { ContentManager } from "../../application/content-manager.js";
import { channels, contentStatuses, type ContentItem } from "../../domain/content/types.js";
import { DirectoryManager } from "../../application/directory-manager.js";
import { PressManager } from "../../application/press-manager.js";
import {
  directoryInputSchema,
  directoryKinds,
  directoryStatuses,
  directoryPatchSchema,
} from "../../domain/directory/types.js";
import {
  accreditationStatuses,
  accreditationSchema,
  eventSchema,
  eventStatuses,
  replacementProfiles,
  replacementStatuses,
} from "../../domain/press/types.js";
import { McpOAuthProvider, mcpScopes, type McpScope, type McpOAuthStore } from "./oauth.js";
import {
  actorFromRequest,
  authenticateUser,
  issueAccessToken,
  setAuthCookie,
  type UserDirectory,
} from "../http/security.js";

type McpExtra = { authInfo?: { scopes: string[]; extra?: Record<string, unknown> } };

const authFromExtra = (extra: McpExtra, scope: McpScope, allowedRoles?: readonly string[]) => {
  if (!extra.authInfo?.scopes.includes(scope)) throw new Error(`Se requiere el scope ${scope}`);
  const userId = typeof extra.authInfo.extra?.userId === "string" ? extra.authInfo.extra.userId : "";
  if (!userId) throw new Error("La identidad del usuario no está disponible");
  const roles = Array.isArray(extra.authInfo.extra?.roles)
    ? extra.authInfo.extra.roles.filter((role): role is string => typeof role === "string")
    : [];
  if (allowedRoles && !allowedRoles.some((role) => roles.includes(role))) {
    throw new Error("Tu usuario no tiene permiso para consultar este módulo");
  }
  return {
    userId,
    roles,
    permissions: Array.isArray(extra.authInfo.extra?.permissions) ? extra.authInfo.extra.permissions : [],
  };
};

const textResult = (value: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value,
});
const publicNote = ({ idempotencyKey: _idempotencyKey, ...note }: ContentItem) => note;

const profileOutputSchema = z.object({
  userId: z.string(),
  roles: z.array(z.string()),
  permissions: z.array(z.string()),
});
const notesOutputSchema = z.object({
  notes: z.array(z.unknown()),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
});
const noteMutationOutputSchema = z
  .object({
    id: z.string(),
    status: z.enum(contentStatuses),
    updatedBy: z.string(),
  })
  .passthrough();
const noteOutputSchema = z.object({ id: z.string(), status: z.enum(contentStatuses) }).passthrough();
const noteUpdateFields = {
  type: z.enum(["article", "post", "carousel", "reel", "story"]).optional(),
  title: z.string().trim().min(1).max(180).optional(),
  summary: z.string().max(600).optional(),
  body: z.string().optional(),
  instagramCopy: z.string().max(2200).optional(),
  facebookCopy: z.string().optional(),
  tags: z.array(z.string().max(80)).optional(),
  channels: z.array(z.enum(channels)).optional(),
  scheduledAt: z.string().datetime().nullable().optional(),
  notes: z.string().optional(),
  author: z.string().max(180).optional(),
  photographer: z.string().max(180).optional(),
  source: z.string().max(500).optional(),
  seoTitle: z.string().max(180).optional(),
  seoDescription: z.string().max(320).optional(),
  canonicalUrl: z.string().url().or(z.literal("")).optional(),
  featured: z.boolean().optional(),
};
const eventOutputSchema = z.object({ id: z.string(), createdBy: z.string() }).passthrough();
const accreditationOutputSchema = z.object({ id: z.string(), managedBy: z.string() }).passthrough();
const statisticsOutputSchema = z
  .object({
    publications: z.record(z.string(), z.unknown()),
    agenda: z.record(z.string(), z.unknown()),
  })
  .passthrough();
const agendaOutputSchema = z.object({
  events: z.array(z.unknown()),
  accreditations: z.array(z.unknown()),
  coverages: z.array(z.unknown()),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
});
const directoryOutputSchema = z.object({
  items: z.array(z.unknown()),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
});
const replacementsOutputSchema = z.object({
  searches: z.array(z.unknown()),
  applications: z.array(z.unknown()).optional(),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
});

const readNotesRoles = ["admin", "editor", "press", "auditor"] as const;
const readAgendaRoles = ["admin", "press", "auditor"] as const;
const readDirectoryRoles = ["admin", "editor", "press", "directory", "auditor"] as const;
const writeDirectoryRoles = ["admin", "editor", "press", "directory"] as const;
const readReplacementsRoles = ["admin", "press", "auditor"] as const;
const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );

const oauthReturnPath = (value: unknown, publicUrl: URL): string | undefined => {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const target = new URL(value, publicUrl);
    if (target.origin !== publicUrl.origin || target.pathname !== "/authorize") return undefined;
    return `${target.pathname}${target.search}`;
  } catch {
    return undefined;
  }
};

const renderOAuthLogin = (returnTo: string, errorMessage?: string): string =>
  `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ingresar a Afterstage</title><style>body{font:16px system-ui;background:#f4f0e8;color:#171717;margin:0;padding:32px}.card{background:#fff;border:2px solid #171717;max-width:560px;margin:8vh auto;padding:32px;box-shadow:8px 8px #c7f36a}h1{font-size:42px;letter-spacing:-.06em;margin-top:0}label{display:block;font-weight:700;margin:18px 0 6px}input{box-sizing:border-box;border:1px solid #171717;font:inherit;padding:12px;width:100%}button{background:#171717;color:#fff;border:0;font:inherit;font-weight:700;margin-top:24px;padding:13px 18px;width:100%}small{color:#57534e}.error{color:#a11f1f;font-weight:700}</style><main class="card"><h1>Ingresar a Afterstage</h1><p>Iniciá sesión para continuar con la conexión segura.</p>${errorMessage ? `<p class="error">${escapeHtml(errorMessage)}</p>` : ""}<form method="post" action="/oauth/login"><input type="hidden" name="return_to" value="${escapeHtml(returnTo)}"><label for="identifier">Usuario o email</label><input id="identifier" name="identifier" autocomplete="username" required><label for="password">Contraseña</label><input id="password" name="password" type="password" autocomplete="current-password" required><button type="submit">Ingresar y continuar</button></form><small>La contraseña se envía únicamente a Afterstage mediante HTTPS y no se comparte con el MCP.</small></main></html>`;

export const createRemoteMcpServer = (
  manager: ContentManager,
  press: PressManager = new PressManager(),
  directory: DirectoryManager = new DirectoryManager(),
) => {
  const server = new McpServer({
    name: "afterstage-notes",
    version: "1.0.0",
  });

  server.registerTool(
    "get_profile",
    {
      title: "Perfil de Afterstage",
      description: "Devuelve la identidad y permisos de la cuenta de Afterstage conectada.",
      inputSchema: {},
      outputSchema: profileOutputSchema,
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["notes:read"] }] },
    },
    async (_input, extra) => textResult(authFromExtra(extra, "notes:read")),
  );

  server.registerTool(
    "obtener_nota",
    {
      title: "Obtener nota",
      description: "Recupera el contenido completo de una nota editorial específica por su ID.",
      inputSchema: { id: z.string().trim().min(1).max(180) },
      outputSchema: noteOutputSchema,
      annotations: { readOnlyHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["notes:read"] }] },
    },
    async ({ id }, extra) => {
      authFromExtra(extra, "notes:read", readNotesRoles);
      return textResult(publicNote(await manager.required(id)));
    },
  );

  server.registerTool(
    "listar_notas",
    {
      title: "Listar notas",
      description: "Busca notas editoriales del workspace de Afterstage.",
      inputSchema: {
        query: z.string().max(200).default(""),
        status: z.enum(contentStatuses).optional(),
        limit: z.number().int().min(1).max(100).default(50),
      },
      outputSchema: notesOutputSchema,
      annotations: { readOnlyHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["notes:read"] }] },
    },
    async ({ query, status, limit }, extra) => {
      authFromExtra(extra, "notes:read", readNotesRoles);
      const candidates = await manager.search(query, status);
      return textResult({ notes: candidates.slice(0, limit).map(publicNote), total: candidates.length, limit });
    },
  );

  server.registerTool(
    "consultar_borradores",
    {
      title: "Consultar borradores",
      description:
        "Devuelve los borradores editoriales del workspace para revisar su contenido antes de avanzar el flujo.",
      inputSchema: {
        query: z.string().max(200).default(""),
        limit: z.number().int().min(1).max(100).default(50),
      },
      outputSchema: notesOutputSchema,
      annotations: { readOnlyHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["notes:read"] }] },
    },
    async ({ query, limit }, extra) => {
      authFromExtra(extra, "notes:read", readNotesRoles);
      const candidates = await manager.search(query, "draft");
      return textResult({ notes: candidates.slice(0, limit).map(publicNote), total: candidates.length, limit });
    },
  );

  server.registerTool(
    "obtener_estadisticas",
    {
      title: "Obtener estadísticas",
      description: "Resume el rendimiento de publicaciones y coberturas de la agenda editorial.",
      inputSchema: {},
      outputSchema: statisticsOutputSchema,
      annotations: { readOnlyHint: true },
      _meta: {
        securitySchemes: [{ type: "oauth2", scopes: ["notes:read", "agenda:read"] }],
      },
    },
    async (_input, extra) => {
      authFromExtra(extra, "notes:read", readNotesRoles);
      authFromExtra(extra, "agenda:read", readAgendaRoles);
      const [published, instagram, pressSnapshot] = await Promise.all([
        manager.store.list("published"),
        manager.instagramMetrics(),
        press.snapshot(),
      ]);
      const coverageReach = pressSnapshot.coverages.reduce((total, coverage) => total + coverage.reach, 0);
      return textResult({
        publications: {
          total: published.length,
          website: published.filter((item) => item.channels.includes("website")).length,
          instagramPublished: published.filter((item) => item.remoteIds.instagram).length,
          facebook: published.filter((item) => item.remoteIds.facebook).length,
          views: published.reduce((total, item) => total + (item.viewCount ?? 0), 0),
          instagramMetrics: instagram,
        },
        agenda: {
          events: pressSnapshot.events.length,
          coveredEvents: pressSnapshot.events.filter((event) => event.status === "covered").length,
          accreditations: pressSnapshot.accreditations.length,
          acceptedAccreditations: pressSnapshot.accreditations.filter((item) =>
            ["accepted", "attended", "coverage_sent"].includes(item.status),
          ).length,
          responses: pressSnapshot.accreditations.filter((item) => item.response.trim()).length,
          coverages: pressSnapshot.coverages.length,
          coverageReach,
        },
      });
    },
  );

  server.registerTool(
    "listar_agenda",
    {
      title: "Listar agenda editorial",
      description: "Consulta eventos, acreditaciones y coberturas de la agenda editorial de Afterstage.",
      inputSchema: {
        query: z.string().max(200).default(""),
        status: z.enum(eventStatuses).optional(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        limit: z.number().int().min(1).max(100).default(50),
      },
      outputSchema: agendaOutputSchema,
      annotations: { readOnlyHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["agenda:read"] }] },
    },
    async ({ query, status, from, to, limit }, extra) => {
      authFromExtra(extra, "agenda:read", readAgendaRoles);
      const normalized = query.trim().toLowerCase();
      const fromMs = from ? Date.parse(from) : undefined;
      const toMs = to ? Date.parse(to) : undefined;
      if (fromMs !== undefined && toMs !== undefined && fromMs > toMs) {
        throw new Error("El inicio del rango no puede ser posterior al final");
      }
      const snapshot = await press.snapshot();
      const candidates = snapshot.events
        .filter((event) => {
          if (status && event.status !== status) return false;
          if (
            normalized &&
            !`${event.name} ${event.artist} ${event.venue} ${event.city} ${event.notes}`
              .toLowerCase()
              .includes(normalized)
          )
            return false;
          const occurrenceDates = [...(event.dates ?? []), event.startsAt]
            .filter((date): date is string => Boolean(date))
            .map((date) => Date.parse(date))
            .filter(Number.isFinite);
          const startsAtMs = occurrenceDates.length ? Math.min(...occurrenceDates) : undefined;
          const endsAtMs = event.endsAt
            ? Math.max(
                Date.parse(event.endsAt),
                ...(occurrenceDates.length ? occurrenceDates : [Date.parse(event.endsAt)]),
              )
            : occurrenceDates.length
              ? Math.max(...occurrenceDates)
              : undefined;
          const isDiscreteSchedule = (event.dates ?? []).length > 1;
          if (isDiscreteSchedule) {
            if (
              fromMs !== undefined &&
              toMs !== undefined &&
              !occurrenceDates.some((date) => date >= fromMs && date <= toMs)
            )
              return false;
            if (fromMs !== undefined && toMs === undefined && !occurrenceDates.some((date) => date >= fromMs))
              return false;
            if (toMs !== undefined && fromMs === undefined && !occurrenceDates.some((date) => date <= toMs))
              return false;
          } else {
            if (fromMs !== undefined && (endsAtMs === undefined || endsAtMs < fromMs)) return false;
            if (toMs !== undefined && (startsAtMs === undefined || startsAtMs > toMs)) return false;
          }
          return true;
        })
        .sort((left, right) => (left.startsAt ?? "9999").localeCompare(right.startsAt ?? "9999"));
      const events = candidates.slice(0, limit);
      const eventIds = new Set(events.map((event) => event.id));
      return textResult({
        events,
        accreditations: snapshot.accreditations.filter((item) => eventIds.has(item.eventId)),
        coverages: snapshot.coverages.filter((item) => item.eventId !== null && eventIds.has(item.eventId)),
        total: candidates.length,
        limit,
      });
    },
  );

  server.registerTool(
    "crear_evento",
    {
      title: "Crear evento",
      description: "Agrega un recital, fecha o encuentro a la agenda editorial de Afterstage.",
      inputSchema: eventSchema.shape,
      outputSchema: eventOutputSchema,
      annotations: { destructiveHint: false, idempotentHint: false },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["agenda:write"] }] },
    },
    async (input, extra) => {
      const actor = authFromExtra(extra, "agenda:write", ["admin", "press"]);
      const event = await press.createEvent(input);
      return textResult({ ...event, createdBy: actor.userId });
    },
  );

  server.registerTool(
    "gestionar_acreditacion",
    {
      title: "Gestionar acreditación",
      description:
        "Registra o actualiza una solicitud de acreditación de prensa. No envía correos automáticamente; el envío queda bajo una acción separada.",
      inputSchema: {
        action: z.enum(["crear", "actualizar"]).default("crear"),
        id: z.string().uuid().optional(),
        eventId: z.string().uuid().optional(),
        contactId: z.string().uuid().nullable().optional(),
        subject: z.string().min(1).max(220).optional(),
        message: z.string().max(10000).optional(),
        status: z.enum(accreditationStatuses).optional(),
        sentAt: z.string().datetime().nullable().optional(),
        followUpAt: z.string().datetime().nullable().optional(),
        response: z.string().max(4000).optional(),
        deliverables: z.string().max(2000).optional(),
      },
      outputSchema: accreditationOutputSchema,
      annotations: { destructiveHint: false, idempotentHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["agenda:write"] }] },
    },
    async ({ action, id, ...input }, extra) => {
      const actor = authFromExtra(extra, "agenda:write", ["admin", "press"]);
      const patch = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
      if (action === "crear") {
        const accreditation = await press.createAccreditation(accreditationSchema.parse(patch));
        return textResult({ ...accreditation, managedBy: actor.userId });
      }
      if (!id) throw new Error("Falta el ID de la solicitud de acreditación");
      const accreditation = await press.updateAccreditation(id, patch);
      return textResult({ ...accreditation, managedBy: actor.userId });
    },
  );

  server.registerTool(
    "buscar_directorio",
    {
      title: "Buscar en directorio",
      description: "Busca artistas, bandas, venues, medios, sellos, agencias y contactos del directorio editorial.",
      inputSchema: {
        query: z.string().max(200).default(""),
        kind: z.enum(directoryKinds).optional(),
        city: z.string().max(120).default(""),
        status: z.enum(directoryStatuses).optional(),
        includeContacts: z.boolean().default(false),
        location: z.object({ lat: z.number(), lng: z.number(), radiusKm: z.number().positive().max(500) }).optional(),
        limit: z.number().int().min(1).max(100).default(50),
      },
      outputSchema: directoryOutputSchema,
      annotations: { readOnlyHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["directory:read"] }] },
    },
    async ({ query, kind, city, status, includeContacts, location, limit }, extra) => {
      const actor = authFromExtra(extra, "directory:read", readDirectoryRoles);
      const items = await directory.list(query, location);
      const candidates = items
        .filter((item) => !kind || item.kind === kind)
        .filter((item) => !city || item.city.toLowerCase().includes(city.trim().toLowerCase()))
        .filter((item) => !status || item.status === status);
      if (includeContacts && !["admin", "editor", "press", "directory"].some((role) => actor.roles.includes(role))) {
        throw new Error("Tu usuario no tiene permiso para consultar datos de contacto");
      }
      const filtered = candidates.slice(0, limit).map((item) => {
        if (includeContacts) return item;
        const { contacts: _contacts, emails: _emails, phones: _phones, ...safeItem } = item;
        return { ...safeItem, contacts: [] };
      });
      return textResult({ items: filtered, total: candidates.length, limit });
    },
  );

  server.registerTool(
    "crear_contacto",
    {
      title: "Crear entrada de directorio",
      description:
        "Crea una entrada del directorio editorial —banda, artista, medio, sala u organización— con sus contactos y datos de comunicación.",
      inputSchema: directoryInputSchema.shape,
      outputSchema: z.object({ id: z.string() }).passthrough(),
      annotations: { destructiveHint: false, idempotentHint: false },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["directory:write"] }] },
    },
    async (input, extra) => {
      const actor = authFromExtra(extra, "directory:write", writeDirectoryRoles);
      const item = await directory.create(input);
      return textResult({ ...item, createdBy: actor.userId });
    },
  );

  server.registerTool(
    "actualizar_contacto",
    {
      title: "Actualizar entrada de directorio",
      description:
        "Actualiza una entrada existente del directorio editorial. Envía solo los campos que cambiaron; no modifica los datos de verificación.",
      inputSchema: { id: z.string().uuid(), ...directoryPatchSchema.shape },
      outputSchema: z.object({ id: z.string() }).passthrough(),
      annotations: { destructiveHint: false, idempotentHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["directory:write"] }] },
    },
    async ({ id, ...input }, extra) => {
      const actor = authFromExtra(extra, "directory:write", writeDirectoryRoles);
      const item = await directory.update(id, input);
      return textResult({ ...item, updatedBy: actor.userId });
    },
  );

  server.registerTool(
    "listar_reemplazos",
    {
      title: "Listar reemplazos",
      description: "Consulta búsquedas de reemplazo abiertas, su estado y postulaciones cuando se soliciten.",
      inputSchema: {
        status: z.enum(replacementStatuses).optional(),
        profile: z.enum(replacementProfiles).optional(),
        city: z.string().max(120).default(""),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        includeApplications: z.boolean().default(false),
        limit: z.number().int().min(1).max(100).default(50),
      },
      outputSchema: replacementsOutputSchema,
      annotations: { readOnlyHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["replacements:read"] }] },
    },
    async ({ status, profile, city, from, to, includeApplications, limit }, extra) => {
      authFromExtra(extra, "replacements:read", readReplacementsRoles);
      const fromMs = from ? Date.parse(from) : undefined;
      const toMs = to ? Date.parse(to) : undefined;
      if (fromMs !== undefined && toMs !== undefined && fromMs > toMs) {
        throw new Error("El inicio del rango no puede ser posterior al final");
      }
      const snapshot = await press.snapshot();
      const candidates = snapshot.replacementSearches
        .filter((item) => !status || item.status === status)
        .filter((item) => !profile || item.profile === profile)
        .filter((item) => !city || item.city.toLowerCase().includes(city.trim().toLowerCase()))
        .filter((item) => {
          const startsAtMs = item.startsAt ? Date.parse(item.startsAt) : undefined;
          if (fromMs !== undefined && (startsAtMs === undefined || startsAtMs < fromMs)) return false;
          if (toMs !== undefined && (startsAtMs === undefined || startsAtMs > toMs)) return false;
          return true;
        })
        .sort((left, right) => (left.startsAt ?? "9999").localeCompare(right.startsAt ?? "9999"));
      const searches = candidates.slice(0, limit);
      return textResult({
        searches,
        ...(includeApplications
          ? {
              applications: snapshot.replacementApplications.filter((item) =>
                searches.some((search) => search.id === item.searchId),
              ),
            }
          : {}),
        total: candidates.length,
        limit,
      });
    },
  );

  server.registerTool(
    "crear_nota",
    {
      title: "Guardar nota redactada por el agente",
      description:
        "Guarda como borrador una nota que el agente ya redactó. El MCP no llama a otra IA, nunca publica ni programa automáticamente y no envía comunicaciones.",
      inputSchema: {
        title: z.string().trim().min(1).max(180),
        summary: z.string().max(600).default(""),
        body: z.string().trim().min(1).max(50_000),
        instagramCopy: z.string().max(2_200).default(""),
        facebookCopy: z.string().default(""),
        channels: z.array(z.enum(channels)).default(["website", "instagram"]),
        tags: z.array(z.string().max(80)).default([]),
        source: z.string().max(500).default(""),
        idempotencyKey: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe("Clave estable para repetir la misma solicitud sin crear otro borrador"),
      },
      outputSchema: z
        .object({
          id: z.string(),
          status: z.literal("draft"),
          createdBy: z.string(),
        })
        .passthrough(),
      annotations: { destructiveHint: false, idempotentHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["notes:write"] }] },
    },
    async (input, extra) => {
      const actor = authFromExtra(extra, "notes:write");
      const note = await manager.createAgentNote(input, actor.userId);
      return textResult({ ...publicNote(note), createdBy: actor.userId });
    },
  );

  server.registerTool(
    "modificar_nota",
    {
      title: "Modificar nota",
      description:
        "Actualiza el contenido editorial de una nota existente. Requiere el ID de la nota y solo modifica los campos enviados; no publica ni cambia estados internos del flujo.",
      inputSchema: {
        id: z.string().trim().min(1).max(180),
        ...noteUpdateFields,
      },
      outputSchema: noteMutationOutputSchema,
      annotations: { destructiveHint: false, idempotentHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["notes:write"] }] },
    },
    async ({ id, ...patch }, extra) => {
      const actor = authFromExtra(extra, "notes:write");
      if (!Object.keys(patch).length) throw new Error("Enviá al menos un campo para modificar la nota");
      const note = await manager.update(id, patch);
      return textResult({ ...publicNote(note), updatedBy: actor.userId });
    },
  );

  server.registerTool(
    "actualizar_nota",
    {
      title: "Actualizar nota",
      description:
        "Nombre canónico para actualizar una nota existente. Modifica solo los campos enviados; no publica ni cambia estados internos del flujo.",
      inputSchema: {
        id: z.string().trim().min(1).max(180),
        ...noteUpdateFields,
      },
      outputSchema: noteMutationOutputSchema,
      annotations: { destructiveHint: false, idempotentHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["notes:write"] }] },
    },
    async ({ id, ...patch }, extra) => {
      const actor = authFromExtra(extra, "notes:write");
      if (!Object.keys(patch).length) throw new Error("Enviá al menos un campo para actualizar la nota");
      const note = await manager.update(id, patch);
      return textResult({ ...publicNote(note), updatedBy: actor.userId });
    },
  );

  server.registerTool(
    "cambiar_estado_nota",
    {
      title: "Cambiar estado de nota",
      description: "Avanza una nota por el flujo editorial validando las transiciones permitidas.",
      inputSchema: {
        id: z.string().trim().min(1).max(180),
        status: z.enum(["idea", "draft", "review", "approved", "scheduled"]),
      },
      outputSchema: noteMutationOutputSchema,
      annotations: { destructiveHint: false, idempotentHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["notes:write"] }] },
    },
    async ({ id, status }, extra) => {
      const actor = authFromExtra(extra, "notes:write");
      const note = await manager.update(id, { status });
      return textResult({ ...publicNote(note), updatedBy: actor.userId });
    },
  );

  return server;
};

export const mountRemoteMcp = (
  app: Express,
  manager: ContentManager,
  press: PressManager,
  directory: DirectoryManager,
  store: McpOAuthStore,
  users: UserDirectory,
  publicUrl: URL,
) => {
  const resourceUrl = new URL("/mcp", publicUrl);
  const provider = new McpOAuthProvider({ store, users, resourceUrl, issuerUrl: publicUrl });
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceUrl);
  const auth = requireBearerAuth({
    verifier: provider,
    requiredScopes: [],
    resourceMetadataUrl,
    expectedResource: resourceUrl,
  });

  app.use(express.urlencoded({ extended: false }));
  app.use("/authorize", async (request, response, next) => {
    const actor = await actorFromRequest(request);
    if (!actor) {
      const returnTo = oauthReturnPath(request.originalUrl, publicUrl);
      if (!returnTo) {
        response.status(400).type("html").send("<p>La solicitud OAuth no es válida.</p>");
        return;
      }
      response.redirect(303, `/oauth/login?return_to=${encodeURIComponent(returnTo)}`);
      return;
    }
    response.locals.afterstageActor = actor;
    next();
  });
  app.use("/.well-known/oauth-authorization-server", (_request, response) => {
    response.json({
      ...createOAuthMetadata({
        provider,
        issuerUrl: publicUrl,
        baseUrl: publicUrl,
        serviceDocumentationUrl: new URL("/politica-editorial", publicUrl),
        scopesSupported: [...mcpScopes],
      }),
      authorization_response_iss_parameter_supported: true,
    });
  });
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: publicUrl,
      baseUrl: publicUrl,
      resourceServerUrl: resourceUrl,
      resourceName: "Afterstage",
      serviceDocumentationUrl: new URL("/politica-editorial", publicUrl),
      scopesSupported: [...mcpScopes],
    }),
  );
  app.get("/oauth/login", (request, response) => {
    const returnTo = oauthReturnPath(request.query.return_to, publicUrl);
    if (!returnTo) {
      response.status(400).type("html").send("<p>El retorno de autenticación no es válido.</p>");
      return;
    }
    response.set("Cache-Control", "no-store").type("html").send(renderOAuthLogin(returnTo));
  });
  app.post("/oauth/login", async (request, response, next) => {
    try {
      const input = z
        .object({
          return_to: z.string().min(1).max(4000),
          identifier: z.string().min(1).max(180),
          password: z.string().min(1).max(200),
        })
        .parse(request.body);
      const returnTo = oauthReturnPath(input.return_to, publicUrl);
      if (!returnTo) {
        response.status(400).type("html").send("<p>El retorno de autenticación no es válido.</p>");
        return;
      }
      const user = await authenticateUser(input.identifier, input.password, users);
      if (!user) {
        response
          .status(401)
          .set("Cache-Control", "no-store")
          .type("html")
          .send(renderOAuthLogin(returnTo, "Las credenciales de Afterstage no son válidas."));
        return;
      }
      const accessToken = issueAccessToken(user);
      response.set("Cache-Control", "no-store");
      setAuthCookie(response, accessToken);
      response.redirect(303, returnTo);
    } catch (error) {
      next(error);
    }
  });
  app.post("/oauth/approve", async (request, response, next) => {
    try {
      const input = z
        .object({
          request_id: z.string().uuid(),
        })
        .parse(request.body);
      const actor = await actorFromRequest(request);
      if (!actor) {
        response
          .status(401)
          .set("Cache-Control", "no-store")
          .type("html")
          .send(
            `<p>Iniciá sesión en Afterstage antes de autorizar la conexión.</p><p><a href="/colaborador">Abrir Afterstage</a></p>`,
          );
        return;
      }
      await provider.approveAuthorization(input.request_id, actor.id, response);
    } catch (error) {
      if (error instanceof OAuthError) {
        response
          .status(400)
          .type("html")
          .send(
            `<p>No se pudo autorizar la conexión.</p><p>La solicitud pudo haber expirado o ya haber sido utilizada. Volvé a iniciar la conexión desde la aplicación que la solicitó.</p>`,
          );
        return;
      }
      next(error);
    }
  });

  app.all("/mcp", cors(), auth, async (request, response, next) => {
    try {
      const server = createRemoteMcpServer(manager, press, directory);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      next(error);
    }
  });

  return provider;
};
