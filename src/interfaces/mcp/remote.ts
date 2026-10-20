import cors from "cors";
import express, { type Express } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { OAuthError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { z } from "zod";
import { ContentManager } from "../../application/content-manager.js";
import { channels, contentStatuses } from "../../domain/content/types.js";
import { DirectoryManager } from "../../application/directory-manager.js";
import { PressManager } from "../../application/press-manager.js";
import { directoryKinds, directoryStatuses } from "../../domain/directory/types.js";
import { eventStatuses, replacementProfiles, replacementStatuses } from "../../domain/press/types.js";
import { McpOAuthProvider, mcpScopes, type McpScope, type McpOAuthStore } from "./oauth.js";
import { actorFromRequest, type UserDirectory } from "../http/security.js";

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

const textResult = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>,
});

const readNotesRoles = ["admin", "editor", "auditor"] as const;
const readAgendaRoles = ["admin", "press", "auditor"] as const;
const readDirectoryRoles = ["admin", "editor", "press", "directory", "auditor"] as const;
const readReplacementsRoles = ["admin", "press", "auditor"] as const;

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
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["notes:read"] }] },
    },
    async (_input, extra) => textResult(authFromExtra(extra, "notes:read")),
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
      annotations: { readOnlyHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["notes:read"] }] },
    },
    async ({ query, status, limit }, extra) => {
      authFromExtra(extra, "notes:read", readNotesRoles);
      return textResult((await manager.search(query, status)).slice(0, limit));
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
      annotations: { readOnlyHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["agenda:read"] }] },
    },
    async ({ query, status, from, to, limit }, extra) => {
      authFromExtra(extra, "agenda:read", readAgendaRoles);
      const normalized = query.trim().toLowerCase();
      const fromMs = from ? Date.parse(from) : undefined;
      const toMs = to ? Date.parse(to) : undefined;
      const snapshot = await press.snapshot();
      const events = snapshot.events
        .filter((event) => {
          if (status && event.status !== status) return false;
          if (
            normalized &&
            !`${event.name} ${event.artist} ${event.venue} ${event.city} ${event.notes}`
              .toLowerCase()
              .includes(normalized)
          )
            return false;
          const startsAtMs = event.startsAt ? Date.parse(event.startsAt) : undefined;
          if (fromMs !== undefined && (startsAtMs === undefined || startsAtMs < fromMs)) return false;
          if (toMs !== undefined && (startsAtMs === undefined || startsAtMs > toMs)) return false;
          return true;
        })
        .sort((left, right) => (left.startsAt ?? "9999").localeCompare(right.startsAt ?? "9999"))
        .slice(0, limit);
      const eventIds = new Set(events.map((event) => event.id));
      return textResult({
        events,
        accreditations: snapshot.accreditations.filter((item) => eventIds.has(item.eventId)),
        coverages: snapshot.coverages.filter((item) => item.eventId !== null && eventIds.has(item.eventId)),
      });
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
      annotations: { readOnlyHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["directory:read"] }] },
    },
    async ({ query, kind, city, status, includeContacts, location, limit }, extra) => {
      authFromExtra(extra, "directory:read", readDirectoryRoles);
      const items = await directory.list(query, location);
      const candidates = items
        .filter((item) => !kind || item.kind === kind)
        .filter((item) => !city || item.city.toLowerCase().includes(city.trim().toLowerCase()))
        .filter((item) => !status || item.status === status);
      const filtered = candidates.slice(0, limit).map((item) => (includeContacts ? item : { ...item, contacts: [] }));
      return textResult({ items: filtered, total: candidates.length });
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
      annotations: { readOnlyHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["replacements:read"] }] },
    },
    async ({ status, profile, city, from, to, includeApplications, limit }, extra) => {
      authFromExtra(extra, "replacements:read", readReplacementsRoles);
      const fromMs = from ? Date.parse(from) : undefined;
      const toMs = to ? Date.parse(to) : undefined;
      const snapshot = await press.snapshot();
      const searches = snapshot.replacementSearches
        .filter((item) => !status || item.status === status)
        .filter((item) => !profile || item.profile === profile)
        .filter((item) => !city || item.city.toLowerCase().includes(city.trim().toLowerCase()))
        .filter((item) => {
          const startsAtMs = item.startsAt ? Date.parse(item.startsAt) : undefined;
          if (fromMs !== undefined && (startsAtMs === undefined || startsAtMs < fromMs)) return false;
          if (toMs !== undefined && (startsAtMs === undefined || startsAtMs > toMs)) return false;
          return true;
        })
        .sort((left, right) => (left.startsAt ?? "9999").localeCompare(right.startsAt ?? "9999"))
        .slice(0, limit);
      return textResult({
        searches,
        ...(includeApplications
          ? {
              applications: snapshot.replacementApplications.filter((item) =>
                searches.some((search) => search.id === item.searchId),
              ),
            }
          : {}),
      });
    },
  );

  server.registerTool(
    "crear_nota_con_ia",
    {
      title: "Crear nota con IA",
      description:
        "Redacta una nota editorial como borrador usando el brief proporcionado. Nunca publica ni envía comunicaciones automáticamente.",
      inputSchema: {
        brief: z.string().trim().min(10).max(8000),
        title: z.string().trim().min(1).max(180).optional(),
        summary: z.string().max(600).default(""),
        channels: z.array(z.enum(channels)).default(["website", "instagram"]),
        tags: z.array(z.string().max(80)).default([]),
        source: z.string().max(500).default(""),
        instructions: z.string().max(2000).default(""),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["notes:write"] }] },
    },
    async (input, extra) => {
      const actor = authFromExtra(extra, "notes:write");
      const note = await manager.createNoteWithAi(input);
      return textResult({ ...note, createdBy: actor.userId });
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
  const provider = new McpOAuthProvider({ store, users, resourceUrl });
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceUrl);
  const auth = requireBearerAuth({
    verifier: provider,
    requiredScopes: [],
    resourceMetadataUrl,
    expectedResource: resourceUrl,
  });

  app.use("/oauth/authorize", async (request, response, next) => {
    response.locals.afterstageActor = await actorFromRequest(request);
    next();
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
  app.use(express.urlencoded({ extended: false }));
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
