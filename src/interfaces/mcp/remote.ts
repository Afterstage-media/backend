import cors from "cors";
import { createHash, createHmac } from "node:crypto";
import express, { type Express } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AnySchema, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
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
import { PlatformManager } from "../../application/platform-manager.js";
import { IdempotentOperationError } from "../../application/press-manager.js";
import { InstagramCommunity } from "../../infrastructure/integrations/instagram-community.js";
import type { InstagramTrustedCollaboratorStore } from "../../infrastructure/persistence/instagram-trusted-collaborators.js";
import type { InstagramConnectionStore } from "../../infrastructure/persistence/instagram-connections.js";
import { channels, contentStatuses, imageInputSchema, type ContentItem } from "../../domain/content/types.js";
import {
  correctedCarouselImageSchema,
  instagramCarouselInputSchema,
  instagramSocialPublicationInputShape,
} from "../../domain/content/social-carousel.js";
import { socialEditorialStandards } from "../../domain/content/social-editorial-standards.js";
import type { SocialTemplateRepository } from "../../domain/content/social-template.js";
import {
  socialSeriesSchema,
  socialSeriesInputShape,
  type SocialSeriesRepository,
} from "../../domain/content/social-series.js";
import { DirectoryManager } from "../../application/directory-manager.js";
import { PressManager } from "../../application/press-manager.js";
import { MailboxManager } from "../../application/mailbox-manager.js";
import type { MailRepository } from "../../infrastructure/persistence/mail-store.js";
import { mailRouteInputSchema, mailRoutePatchSchema } from "../../domain/mail/routing.js";
import { blockedSendersSchema } from "../../domain/mail/blacklist.js";
import { mailReplyIdempotencyKeySchema, mailReplySchema } from "../../domain/mail/types.js";
import { idempotencyKeySchema } from "../../domain/idempotency.js";
import {
  coverageApplicationSchema,
  coverageRequestSchema,
  forumPostSchema,
  forumThreadSchema,
  insuranceRequestSchema,
  marketplaceListingSchema,
  photographerProfileSchema,
  transportOfferSchema,
  transportRequestSchema,
} from "../../domain/platform/types.js";
import { editorialVoiceInputSchema } from "../../domain/editorial-voice/types.js";
import {
  MemoryEditorialVoiceStore,
  type EditorialVoiceRepository,
} from "../../infrastructure/persistence/editorial-voice-store.js";
import {
  directoryInputSchema,
  directoryKinds,
  directoryStatuses,
  directoryPatchSchema,
} from "../../domain/directory/types.js";
import {
  accreditationStatuses,
  accreditationSchema,
  contactSchema,
  coverageSchema,
  eventSchema,
  mcpCreateEventSchema,
  eventStatuses,
  mediaKitSchema,
  replacementProfiles,
  replacementSearchSchema,
  replacementStatuses,
} from "../../domain/press/types.js";
import { McpOAuthProvider, mcpScopeRoles, mcpScopes, type McpScope, type McpOAuthStore } from "./oauth.js";
import {
  actorFromRequest,
  authenticateUser,
  issueAccessToken,
  setAuthCookie,
  type UserDirectory,
} from "../http/security.js";
import { log } from "../http/logger.js";

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

const runMcpIdempotentOperation = async <T extends Record<string, unknown>>(
  press: PressManager,
  actorId: string,
  action: string,
  idempotencyKey: string,
  payload: Record<string, unknown>,
  perform: () => Promise<T>,
): Promise<T> => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("No se puede asegurar el reintento de esta operación ahora");
  const requestHash = createHmac("sha256", secret).update(JSON.stringify({ action, payload })).digest("hex");
  const operationKey = createHash("sha256").update(`mcp:${action}:${actorId}:${idempotencyKey}`).digest("hex");
  const operation = await press.beginIdempotentOperation(operationKey, requestHash);
  if (operation.status === "conflict" || operation.status === "pending")
    throw new IdempotentOperationError(operation.status);
  if (operation.status === "completed") return operation.result as T;
  const result = await perform();
  await press.completeIdempotentOperation(operationKey, result);
  return result;
};

const publicNote = ({ idempotencyKey: _idempotencyKey, ...note }: ContentItem) => note;
const publicCarousel = (note: ContentItem, createdBy: string) => ({
  id: note.id,
  status: note.status,
  createdBy,
  title: note.title,
  instagramCopy: note.instagramCopy,
  templateId: note.socialTemplateId ?? "",
  templateVersion: note.socialTemplateVersion ?? 1,
  images: note.assets.map((asset, index) => ({
    slide: index + 1,
    url: asset.url,
    altText: asset.altText,
    credit: asset.credit,
  })),
});

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
const socialEditorialGuidanceSchema = z.object({
  purpose: z.string(),
  angle: z.string(),
  verify: z.array(z.string()),
  slidePlan: z.array(z.string()),
  caption: z.string(),
  voice: z.string(),
  avoid: z.array(z.string()),
});
const socialTemplatesOutputSchema = z.object({
  editorialStandards: z.object({
    purpose: z.string(),
    accuracy: z.array(z.string()),
    writing: z.array(z.string()),
    images: z.array(z.string()),
    finalCheck: z.array(z.string()),
  }),
  templates: z.array(
    z.object({
      id: z.string(),
      visualStyleId: z.string(),
      outputType: z.enum(["post", "story", "carousel"]),
      name: z.string(),
      description: z.string(),
      canvas: z.object({ width: z.number().int(), height: z.number().int() }),
      visualStyle: z.object({
        id: z.string(),
        name: z.string(),
        description: z.string(),
        layout: z.enum(["photo-overlay", "split-panel", "type-poster"]),
        coverEyebrow: z.string(),
        palette: z.object({
          background: z.string(),
          foreground: z.string(),
          accent: z.string(),
          overlay: z.string(),
        }),
      }),
    }),
  ),
  editorialGuides: z.array(
    z.object({
      templateId: z.string(),
      slug: z.string(),
      name: z.string(),
      description: z.string(),
      editorialSection: z.string(),
      outputType: z.string(),
      channels: z.array(z.string()),
      templateVersion: z.number().int().positive(),
      guidanceVersion: z.number().int().nonnegative(),
      fields: z.array(z.object({ key: z.string(), label: z.string(), required: z.boolean(), maxLength: z.number() })),
      slides: z.array(
        z.object({
          eyebrow: z.string(),
          titleField: z.string(),
          bodyField: z.string().optional(),
          accent: z.string(),
          background: z.string(),
        }),
      ),
      editorialGuidance: socialEditorialGuidanceSchema,
    }),
  ),
  totalStyles: z.number().int().nonnegative(),
  totalGuides: z.number().int().nonnegative(),
});
const socialSeriesOutputSchema = z.object({ series: z.array(z.unknown()), total: z.number().int().nonnegative() });
const socialSeriesMutationOutputSchema = z.object({ series: z.unknown() });
const carouselOutputSchema = z.object({
  id: z.string(),
  status: z.enum(contentStatuses),
  createdBy: z.string(),
  title: z.string(),
  instagramCopy: z.string(),
  templateId: z.string(),
  templateVersion: z.number().int().positive(),
  images: z.array(
    z.object({ slide: z.number().int().positive(), url: z.string().url(), altText: z.string(), credit: z.string() }),
  ),
});
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
const pressRecordOutputSchema = z.object({ id: z.string() }).passthrough();
const pressRemovalOutputSchema = z.object({ id: z.string(), deleted: z.boolean() });
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
const editorialVoiceOutputSchema = z.object({
  configured: z.boolean(),
  authorId: z.string(),
  guide: z.string(),
  examples: z.array(z.string()),
  revision: z.number().int().nonnegative(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
});
const mailRouteOutputSchema = z.object({
  id: z.string(),
  address: z.string(),
  label: z.string(),
  kind: z.enum(["personal", "distribution"]),
  destinations: z.array(z.string()),
});
const mailRoutesOutputSchema = z.object({ routes: z.array(mailRouteOutputSchema) });
const mailBlacklistOutputSchema = z.object({ entries: z.array(z.string()) });
const mailThreadSummaryOutputSchema = z.object({
  id: z.string(),
  subject: z.string(),
  mailbox: z.string().optional(),
  mailboxType: z.enum(["personal", "distribution"]).optional(),
  mailboxLabel: z.string().optional(),
  participants: z.array(z.string()),
  lastMessageAt: z.string(),
  unreadCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  preview: z.string(),
  lastDirection: z.enum(["inbound", "outbound"]),
});
const mailMessageOutputSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  direction: z.enum(["inbound", "outbound"]),
  messageId: z.string(),
  deliveredTo: z.string().optional(),
  replyTo: z.string().optional(),
  inReplyTo: z.string().optional(),
  references: z.array(z.string()),
  from: z.string(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  subject: z.string(),
  text: z.string(),
  html: z.string().optional(),
  receivedAt: z.string(),
  createdAt: z.string(),
  readAt: z.string().nullable().optional(),
});
const mailThreadOutputSchema = z.object({
  id: z.string(),
  subject: z.string(),
  mailbox: z.string().optional(),
  mailboxType: z.enum(["personal", "distribution"]).optional(),
  mailboxLabel: z.string().optional(),
  participants: z.array(z.string()),
  lastMessageAt: z.string(),
  unreadCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  messages: z.array(mailMessageOutputSchema),
});

const readNotesRoles = ["admin", "editor", "press", "auditor"] as const;
const writeNotesRoles = ["admin", "editor"] as const;
const readAgendaRoles = ["admin", "press", "auditor"] as const;
const readDirectoryRoles = ["admin", "editor", "press", "directory", "auditor"] as const;
const writeDirectoryRoles = ["admin", "editor", "press", "directory"] as const;
const readReplacementsRoles = ["admin", "press", "auditor"] as const;
const readEditorialVoiceRoles = ["admin", "editor", "press", "auditor"] as const;
const writeEditorialVoiceRoles = ["admin", "editor", "press"] as const;
const readMailRoles = ["admin", "editor"] as const;
const writeMailRoles = ["admin", "editor"] as const;
const replyMailRoles = ["admin", "editor", "press", "community"] as const;
const toolScopes: Record<string, readonly McpScope[]> = {
  get_profile: ["notes:read"],
  obtener_nota: ["notes:read"],
  listar_notas: ["notes:read"],
  consultar_borradores: ["notes:read"],
  obtener_estadisticas: ["notes:read", "agenda:read"],
  listar_agenda: ["agenda:read"],
  crear_evento: ["agenda:write"],
  actualizar_evento: ["agenda:write"],
  eliminar_evento: ["agenda:write"],
  crear_contacto_prensa: ["agenda:write"],
  actualizar_contacto_prensa: ["agenda:write"],
  eliminar_contacto_prensa: ["agenda:write"],
  gestionar_acreditacion: ["agenda:write"],
  eliminar_acreditacion: ["agenda:write"],
  crear_cobertura: ["agenda:write"],
  actualizar_cobertura: ["agenda:write"],
  eliminar_cobertura: ["agenda:write"],
  ejecutar_seguimientos_prensa: ["agenda:write"],
  obtener_dossier_prensa: ["agenda:read"],
  actualizar_dossier_prensa: ["agenda:write"],
  buscar_directorio: ["directory:read"],
  crear_contacto: ["directory:write"],
  actualizar_contacto: ["directory:write"],
  listar_reemplazos: ["replacements:read"],
  crear_busqueda_reemplazo: ["agenda:write"],
  actualizar_busqueda_reemplazo: ["agenda:write"],
  eliminar_busqueda_reemplazo: ["agenda:write"],
  listar_postulaciones_reemplazo: ["replacements:read"],
  asignar_postulacion_reemplazo: ["agenda:write"],
  crear_nota: ["notes:write"],
  recompartir_nota_instagram: ["instagram:publish"],
  crear_carrusel_instagram: ["notes:write"],
  crear_pieza_instagram: ["notes:write"],
  crear_serie_social: ["notes:write"],
  actualizar_serie_social: ["notes:write"],
  listar_series_sociales: ["notes:read"],
  crear_borrador_serie_social: ["notes:write"],
  listar_plantillas_sociales: ["notes:read"],
  corregir_lamina_instagram: ["notes:write"],
  agregar_imagenes_nota: ["notes:write"],
  modificar_nota: ["notes:write"],
  actualizar_nota: ["notes:write"],
  cambiar_estado_nota: ["notes:write"],
  obtener_voz_notero: ["voice:read"],
  actualizar_voz_notero: ["voice:write"],
  listar_rutas_correo: ["mail:read"],
  listar_blacklist_correo: ["mail:read"],
  actualizar_blacklist_correo: ["mail:write"],
  listar_conversaciones_correo: ["mail:read"],
  leer_conversacion_correo: ["mail:read"],
  responder_conversacion_correo: ["mail:reply"],
  crear_ruta_correo: ["mail:write"],
  actualizar_ruta_correo: ["mail:write"],
  eliminar_ruta_correo: ["mail:write"],
  instagram_listar_conversaciones: ["notes:read"],
  instagram_leer_mensajes: ["notes:read"],
  instagram_responder_mensaje: ["notes:write"],
  instagram_listar_comentarios: ["notes:read"],
  instagram_responder_comentario: ["notes:write"],
  instagram_like_comentario: ["notes:write"],
  listar_colaboradores_confiables_instagram: ["notes:read"],
  agregar_colaborador_confiable_instagram: ["notes:write"],
  quitar_colaborador_confiable_instagram: ["notes:write"],
  obtener_estado_plataforma: ["platform:read"],
  gestionar_operacion_plataforma: ["platform:write"],
};

const toolsAllowedForRoles = (roles: readonly string[]): Set<string> =>
  new Set(
    Object.entries(toolScopes)
      .filter(([name, scopes]) =>
        name.startsWith("instagram_") || name.includes("colaborador")
          ? roles.includes("admin")
          : scopes.every((scope) => mcpScopeRoles[scope].some((role) => roles.includes(role))),
      )
      .map(([name]) => name),
  );
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
  roles?: readonly string[],
  editorialVoice: EditorialVoiceRepository = new MemoryEditorialVoiceStore(),
  socialTemplates?: SocialTemplateRepository,
  mailbox?: MailRepository,
  instagramTrustedCollaborators?: InstagramTrustedCollaboratorStore,
  instagramConnections?: InstagramConnectionStore,
  socialSeries?: SocialSeriesRepository,
  platform: PlatformManager = new PlatformManager(),
  correlationId?: string,
) => {
  const server = new McpServer({
    name: "afterstage-notes",
    version: "1.0.0",
  });
  const allowedTools = roles ? toolsAllowedForRoles(roles) : undefined;
  const mailboxManager = mailbox ? new MailboxManager(mailbox, undefined, press) : undefined;
  const instagramService = instagramTrustedCollaborators
    ? new InstagramCommunity(instagramTrustedCollaborators, instagramConnections)
    : undefined;
  const registerTool = <
    OutputArgs extends ZodRawShapeCompat | AnySchema,
    InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined,
  >(
    name: string,
    config: {
      title?: string;
      description?: string;
      inputSchema?: InputArgs;
      outputSchema?: OutputArgs;
      annotations?: ToolAnnotations;
      _meta?: Record<string, unknown>;
    },
    callback: ToolCallback<InputArgs>,
  ) => {
    if (allowedTools && !allowedTools.has(name)) return;
    const tracedCallback = async (
      input: Parameters<ToolCallback<InputArgs>>[0],
      extra: Parameters<ToolCallback<InputArgs>>[1],
    ) => {
      const startedAt = Date.now();
      try {
        const result = await callback(input, extra!);
        log("info", "mcp_tool_completed", {
          correlationId,
          tool: name,
          durationMs: Date.now() - startedAt,
        });
        return result;
      } catch (error) {
        log("error", "mcp_tool_failed", {
          correlationId,
          tool: name,
          durationMs: Date.now() - startedAt,
          errorType: error instanceof Error ? error.name : "UnknownError",
        });
        throw error;
      }
    };
    return server.registerTool(name, config, tracedCallback as ToolCallback<InputArgs>);
  };

  registerTool(
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

  const requireInstagramAdmin = (extra: McpExtra, scope: "notes:read" | "notes:write") =>
    authFromExtra(extra, scope, ["admin"]);
  const instagramItemsOutput = z.object({ items: z.array(z.record(z.string(), z.unknown())) });
  registerTool(
    "instagram_listar_conversaciones",
    {
      title: "Leer conversaciones de Instagram",
      description: "Lista conversaciones recientes del inbox profesional conectado.",
      inputSchema: { limit: z.number().int().min(1).max(100).default(25) },
      outputSchema: instagramItemsOutput,
      annotations: { readOnlyHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["notes:read"] }] },
    },
    async ({ limit }, extra) => {
      requireInstagramAdmin(extra, "notes:read");
      if (!instagramService) throw new Error("La integración de Instagram no está configurada");
      return textResult({ items: await instagramService.listConversations(limit) });
    },
  );
  registerTool(
    "instagram_leer_mensajes",
    {
      title: "Leer mensajes de Instagram",
      description: "Lee los mensajes de una conversación del inbox profesional conectado.",
      inputSchema: {
        conversationId: z.string().trim().min(1).max(180),
        limit: z.number().int().min(1).max(100).default(50),
      },
      outputSchema: instagramItemsOutput,
      annotations: { readOnlyHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["notes:read"] }] },
    },
    async ({ conversationId, limit }, extra) => {
      requireInstagramAdmin(extra, "notes:read");
      if (!instagramService) throw new Error("La integración de Instagram no está configurada");
      return textResult({ items: await instagramService.listMessages(conversationId, limit) });
    },
  );
  registerTool(
    "instagram_responder_mensaje",
    {
      title: "Responder un mensaje de Instagram",
      description:
        "Envía un mensaje de texto a una persona que ya inició una conversación con Afterstage. Requiere una idempotencyKey única; al reintentar el mismo envío, reutilizá la clave para no duplicarlo. Una operación cuyo resultado externo sea incierto queda pendiente y no se reenvía automáticamente.",
      inputSchema: {
        recipientId: z.string().trim().min(1).max(180),
        message: z.string().trim().min(1).max(1000),
        idempotencyKey: idempotencyKeySchema,
      },
      outputSchema: z.object({ recipientId: z.string(), messageId: z.unknown().nullable() }),
      annotations: { destructiveHint: false, idempotentHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["notes:write"] }] },
    },
    async ({ recipientId, message, idempotencyKey }, extra) => {
      const actor = requireInstagramAdmin(extra, "notes:write");
      if (!instagramService) throw new Error("La integración de Instagram no está configurada");
      return textResult(
        await runMcpIdempotentOperation(
          press,
          actor.userId,
          "instagram-send-message",
          idempotencyKey,
          { recipientId, message },
          () => instagramService.sendMessage(recipientId, message),
        ),
      );
    },
  );
  registerTool(
    "instagram_listar_comentarios",
    {
      title: "Leer comentarios de Instagram",
      description: "Lista comentarios de una publicación de Afterstage.",
      inputSchema: { mediaId: z.string().trim().min(1).max(180), limit: z.number().int().min(1).max(100).default(100) },
      outputSchema: instagramItemsOutput,
      annotations: { readOnlyHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["notes:read"] }] },
    },
    async ({ mediaId, limit }, extra) => {
      requireInstagramAdmin(extra, "notes:read");
      if (!instagramService) throw new Error("La integración de Instagram no está configurada");
      return textResult({ items: await instagramService.listComments(mediaId, limit) });
    },
  );
  registerTool(
    "instagram_responder_comentario",
    {
      title: "Responder un comentario de Instagram",
      description:
        "Publica una respuesta a un comentario en una publicación de Afterstage. Requiere una idempotencyKey única; al reintentar el mismo envío, reutilizá la clave para no duplicarlo. Una operación cuyo resultado externo sea incierto queda pendiente y no se reenvía automáticamente.",
      inputSchema: {
        commentId: z.string().trim().min(1).max(180),
        message: z.string().trim().min(1).max(2200),
        idempotencyKey: idempotencyKeySchema,
      },
      outputSchema: z.object({ commentId: z.string(), replyId: z.unknown().nullable() }),
      annotations: { destructiveHint: false, idempotentHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["notes:write"] }] },
    },
    async ({ commentId, message, idempotencyKey }, extra) => {
      const actor = requireInstagramAdmin(extra, "notes:write");
      if (!instagramService) throw new Error("La integración de Instagram no está configurada");
      return textResult(
        await runMcpIdempotentOperation(
          press,
          actor.userId,
          "instagram-reply-comment",
          idempotencyKey,
          { commentId, message },
          () => instagramService.replyToComment(commentId, message),
        ),
      );
    },
  );
  registerTool(
    "instagram_like_comentario",
    {
      title: "Dar Me gusta a un comentario de Instagram",
      description: "Marca con Me gusta un comentario de la cuenta profesional conectada.",
      inputSchema: { commentId: z.string().trim().min(1).max(180) },
      outputSchema: z.object({ commentId: z.string(), liked: z.boolean() }),
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["notes:write"] }] },
    },
    async ({ commentId }, extra) => {
      requireInstagramAdmin(extra, "notes:write");
      if (!instagramService) throw new Error("La integración de Instagram no está configurada");
      return textResult(await instagramService.likeComment(commentId));
    },
  );
  registerTool(
    "listar_colaboradores_confiables_instagram",
    {
      title: "Listar colaboradores confiables de Instagram",
      description: "Lista cuentas cuyas invitaciones de colaboración pueden aceptarse automáticamente.",
      inputSchema: {},
      outputSchema: z.object({
        accounts: z.array(
          z.object({ username: z.string(), createdAt: z.string(), createdBy: z.string(), updatedAt: z.string() }),
        ),
      }),
      annotations: { readOnlyHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["notes:read"] }] },
    },
    async (_input, extra) => {
      requireInstagramAdmin(extra, "notes:read");
      if (!instagramTrustedCollaborators) throw new Error("La lista de cuentas confiables no está configurada");
      return textResult({ accounts: await instagramTrustedCollaborators.list() });
    },
  );
  registerTool(
    "agregar_colaborador_confiable_instagram",
    {
      title: "Agregar colaborador confiable de Instagram",
      description: "Agrega un @usuario a la lista de cuentas cuyas colaboraciones pueden aceptarse automáticamente.",
      inputSchema: { username: z.string().trim().min(1).max(100) },
      outputSchema: z.object({
        username: z.string(),
        createdAt: z.string(),
        createdBy: z.string(),
        updatedAt: z.string(),
      }),
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["notes:write"] }] },
    },
    async ({ username }, extra) => {
      const actor = requireInstagramAdmin(extra, "notes:write");
      if (!instagramTrustedCollaborators) throw new Error("La lista de cuentas confiables no está configurada");
      return textResult(await instagramTrustedCollaborators.add(username, actor.userId));
    },
  );
  registerTool(
    "quitar_colaborador_confiable_instagram",
    {
      title: "Quitar colaborador confiable de Instagram",
      description: "Quita un @usuario de la lista autorizada para aceptación automática.",
      inputSchema: { username: z.string().trim().min(1).max(100) },
      outputSchema: z.object({ username: z.string(), removed: z.boolean() }),
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["notes:write"] }] },
    },
    async ({ username }, extra) => {
      requireInstagramAdmin(extra, "notes:write");
      if (!instagramTrustedCollaborators) throw new Error("La lista de cuentas confiables no está configurada");
      const normalized = username.trim().replace(/^@/, "").toLowerCase();
      return textResult({ username: normalized, removed: await instagramTrustedCollaborators.remove(normalized) });
    },
  );

  const canAccessOtherAuthorVoice = (rolesForUser: readonly string[]) =>
    rolesForUser.some((role) => ["admin", "editor", "auditor"].includes(role));
  const resolveVoiceAuthorId = (actor: ReturnType<typeof authFromExtra>, requestedAuthorId?: string) => {
    const authorId = requestedAuthorId?.trim() || actor.userId;
    if (authorId !== actor.userId && !canAccessOtherAuthorVoice(actor.roles)) {
      throw new Error("Solo podés gestionar la voz editorial de tu propio usuario");
    }
    return authorId;
  };
  const publicEditorialVoice = (authorId: string, voice: Awaited<ReturnType<EditorialVoiceRepository["get"]>>) => ({
    configured: Boolean(voice && (voice.guide.trim() || voice.examples.length)),
    authorId,
    guide: voice?.guide ?? "",
    examples: voice?.examples ?? [],
    revision: voice?.revision ?? 0,
    createdAt: voice?.createdAt ?? null,
    updatedAt: voice?.updatedAt ?? null,
    updatedBy: voice?.updatedBy ?? null,
  });

  registerTool(
    "obtener_voz_notero",
    {
      title: "Obtener voz editorial del notero",
      description:
        "Consulta la guía editorial opcional de un notero: tono, lenguaje, acento, criterios y ejemplos. Si no está configurada, devuelve configured=false para que el agente escriba con las reglas generales.",
      inputSchema: { authorId: z.string().trim().min(1).max(180).optional() },
      outputSchema: editorialVoiceOutputSchema,
      annotations: { readOnlyHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["voice:read"] }] },
    },
    async ({ authorId }, extra) => {
      const actor = authFromExtra(extra, "voice:read", readEditorialVoiceRoles);
      const targetAuthorId = resolveVoiceAuthorId(actor, authorId);
      return textResult(publicEditorialVoice(targetAuthorId, await editorialVoice.get(targetAuthorId)));
    },
  );

  registerTool(
    "actualizar_voz_notero",
    {
      title: "Actualizar voz editorial del notero",
      description:
        "Guarda o reemplaza una guía editorial opcional en lenguaje natural. No es obligatoria para crear notas; una guía vacía y sin ejemplos la deja sin configurar.",
      inputSchema: {
        authorId: z.string().trim().min(1).max(180).optional(),
        ...editorialVoiceInputSchema.shape,
      },
      outputSchema: editorialVoiceOutputSchema,
      annotations: { destructiveHint: false, idempotentHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["voice:write"] }] },
    },
    async ({ authorId, guide, examples }, extra) => {
      const actor = authFromExtra(extra, "voice:write", writeEditorialVoiceRoles);
      const targetAuthorId = resolveVoiceAuthorId(actor, authorId);
      const voice = await editorialVoice.upsert(targetAuthorId, { guide, examples }, actor.userId);
      return textResult(publicEditorialVoice(targetAuthorId, voice));
    },
  );

  registerTool(
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

  registerTool(
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

  registerTool(
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

  registerTool(
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

  registerTool(
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

  registerTool(
    "crear_evento",
    {
      title: "Crear evento",
      description:
        "Agrega un recital, fecha o encuentro a la agenda editorial de Afterstage. Las solicitudes idénticas se deduplican; también podés enviar una idempotencyKey estable. Artista, fecha, venue, ciudad, coordenadas y género son obligatorios.",
      inputSchema: { ...mcpCreateEventSchema.shape, idempotencyKey: idempotencyKeySchema.optional() },
      outputSchema: eventOutputSchema,
      annotations: { destructiveHint: false, idempotentHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["agenda:write"] }] },
    },
    async ({ idempotencyKey, ...input }, extra) => {
      const actor = authFromExtra(extra, "agenda:write", ["admin", "press"]);
      const eventInput = mcpCreateEventSchema.parse(input);
      const secret = process.env.JWT_SECRET;
      if (!secret) throw new Error("No se puede asegurar el reintento de esta operación ahora");
      const requestHash = createHmac("sha256", secret)
        .update(JSON.stringify({ action: "crear_evento", data: eventInput }))
        .digest("hex");
      const operationIdentity = idempotencyKey ? `key:${idempotencyKey}` : `payload:${requestHash}`;
      const operationKey = createHash("sha256").update(`mcp-event:${actor.userId}:${operationIdentity}`).digest("hex");
      const operation = await press.beginIdempotentOperation(operationKey, requestHash);
      if (operation.status === "conflict" || operation.status === "pending")
        throw new IdempotentOperationError(operation.status);
      if (operation.status === "completed")
        return textResult({
          ...(operation.result as { id: string }),
          createdBy: actor.userId,
          replayed: true,
        });
      const event = await press.createEvent(eventInput);
      const result = { id: event.id };
      await press.completeIdempotentOperation(operationKey, result);
      return textResult({ ...result, createdBy: actor.userId, replayed: false });
    },
  );

  registerTool(
    "gestionar_acreditacion",
    {
      title: "Gestionar acreditación",
      description:
        "Registra o actualiza una solicitud de acreditación de prensa. Para crear, podés enviar una idempotencyKey estable; si se omite, las solicitudes con el mismo contenido se deduplican. No envía correos automáticamente; el envío queda bajo una acción separada.",
      inputSchema: {
        action: z.enum(["crear", "actualizar"]).default("crear"),
        id: z.string().uuid().optional(),
        idempotencyKey: idempotencyKeySchema.optional(),
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
    async ({ action, id, idempotencyKey, ...input }, extra) => {
      const actor = authFromExtra(extra, "agenda:write", ["admin", "press"]);
      const patch = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
      if (action === "crear") {
        const accreditationInput = accreditationSchema.parse(patch);
        const secret = process.env.JWT_SECRET;
        if (!secret) throw new Error("No se puede asegurar el reintento de esta operación ahora");
        const requestHash = createHmac("sha256", secret)
          .update(JSON.stringify({ action, data: accreditationInput }))
          .digest("hex");
        const operationIdentity = idempotencyKey ? `key:${idempotencyKey}` : `payload:${requestHash}`;
        const operationKey = createHash("sha256")
          .update(`mcp-accreditation:${actor.userId}:${operationIdentity}`)
          .digest("hex");
        const operation = await press.beginIdempotentOperation(operationKey, requestHash);
        if (operation.status === "conflict" || operation.status === "pending")
          throw new IdempotentOperationError(operation.status);
        if (operation.status === "completed")
          return textResult({
            ...(operation.result as { id: string; status: string }),
            managedBy: actor.userId,
            replayed: true,
          });
        const accreditation = await press.createAccreditation(accreditationInput);
        const result = { id: accreditation.id, status: accreditation.status };
        await press.completeIdempotentOperation(operationKey, result);
        return textResult({ ...result, managedBy: actor.userId, replayed: false });
      }
      if (!id) throw new Error("Falta el ID de la solicitud de acreditación");
      const accreditation = await press.updateAccreditation(id, patch);
      return textResult({ ...accreditation, managedBy: actor.userId });
    },
  );

  registerTool(
    "enviar_acreditacion",
    {
      title: "Enviar solicitud de acreditación",
      description:
        "Envía por email una solicitud de acreditación preparada. Requiere una clave estable para que los reintentos no dupliquen el envío.",
      inputSchema: {
        id: z.string().uuid(),
        idempotencyKey: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .regex(/^[A-Za-z0-9._:-]+$/),
      },
      outputSchema: z.object({
        messageId: z.string(),
        dryRun: z.boolean(),
        accreditationId: z.string(),
        to: z.string().email(),
      }),
      annotations: { destructiveHint: false, idempotentHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["agenda:write"] }] },
    },
    async ({ id, idempotencyKey }, extra) => {
      const actor = authFromExtra(extra, "agenda:write", ["admin", "press"]);
      return textResult(await press.sendAccreditation(id, false, { actorId: actor.userId, key: idempotencyKey }));
    },
  );

  registerTool(
    "actualizar_evento",
    {
      title: "Actualizar evento de prensa",
      description: "Actualiza solo los campos enviados de un evento y vuelve a validar sus fechas relacionadas.",
      inputSchema: { id: z.string().uuid(), ...eventSchema.partial().shape },
      outputSchema: pressRecordOutputSchema,
      annotations: { destructiveHint: false, idempotentHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["agenda:write"] }] },
    },
    async ({ id, ...patch }, extra) => {
      authFromExtra(extra, "agenda:write", ["admin", "press"]);
      if (!Object.keys(patch).length) throw new Error("Enviá al menos un campo para actualizar el evento");
      const event = await press.updateEvent(id, patch);
      if (!event) throw new Error("Evento no encontrado");
      return textResult(event);
    },
  );

  registerTool(
    "eliminar_evento",
    {
      title: "Eliminar evento de prensa",
      description: "Elimina un evento solo si no tiene acreditaciones ni coberturas vinculadas.",
      inputSchema: { id: z.string().uuid() },
      outputSchema: pressRemovalOutputSchema,
      annotations: { destructiveHint: true, idempotentHint: false },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["agenda:write"] }] },
    },
    async ({ id }, extra) => {
      authFromExtra(extra, "agenda:write", ["admin", "press"]);
      return textResult({ id, deleted: await press.remove("events", id) });
    },
  );

  registerTool(
    "crear_contacto_prensa",
    {
      title: "Crear contacto de prensa",
      description: "Crea un contacto del módulo de prensa, separado del directorio editorial público.",
      inputSchema: contactSchema.shape,
      outputSchema: pressRecordOutputSchema,
      annotations: { destructiveHint: false, idempotentHint: false },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["agenda:write"] }] },
    },
    async (input, extra) => {
      authFromExtra(extra, "agenda:write", ["admin", "press"]);
      return textResult(await press.createContact(input));
    },
  );

  registerTool(
    "actualizar_contacto_prensa",
    {
      title: "Actualizar contacto de prensa",
      description: "Actualiza solo los campos enviados de un contacto de prensa.",
      inputSchema: { id: z.string().uuid(), ...contactSchema.partial().shape },
      outputSchema: pressRecordOutputSchema,
      annotations: { destructiveHint: false, idempotentHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["agenda:write"] }] },
    },
    async ({ id, ...patch }, extra) => {
      authFromExtra(extra, "agenda:write", ["admin", "press"]);
      if (!Object.keys(patch).length) throw new Error("Enviá al menos un campo para actualizar el contacto");
      const contact = await press.updateContact(id, patch);
      if (!contact) throw new Error("Contacto no encontrado");
      return textResult(contact);
    },
  );

  registerTool(
    "eliminar_contacto_prensa",
    {
      title: "Eliminar contacto de prensa",
      description: "Elimina un contacto solo si no tiene acreditaciones vinculadas.",
      inputSchema: { id: z.string().uuid() },
      outputSchema: pressRemovalOutputSchema,
      annotations: { destructiveHint: true, idempotentHint: false },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["agenda:write"] }] },
    },
    async ({ id }, extra) => {
      authFromExtra(extra, "agenda:write", ["admin", "press"]);
      return textResult({ id, deleted: await press.remove("contacts", id) });
    },
  );

  registerTool(
    "eliminar_acreditacion",
    {
      title: "Eliminar solicitud de acreditación",
      description: "Elimina una solicitud de acreditación del módulo de prensa.",
      inputSchema: { id: z.string().uuid() },
      outputSchema: pressRemovalOutputSchema,
      annotations: { destructiveHint: true, idempotentHint: false },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["agenda:write"] }] },
    },
    async ({ id }, extra) => {
      authFromExtra(extra, "agenda:write", ["admin", "press"]);
      return textResult({ id, deleted: await press.remove("accreditations", id) });
    },
  );

  registerTool(
    "crear_cobertura",
    {
      title: "Registrar cobertura",
      description: "Registra una cobertura y valida que el evento vinculado exista.",
      inputSchema: coverageSchema.shape,
      outputSchema: pressRecordOutputSchema,
      annotations: { destructiveHint: false, idempotentHint: false },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["agenda:write"] }] },
    },
    async (input, extra) => {
      authFromExtra(extra, "agenda:write", ["admin", "press"]);
      return textResult(await press.createCoverage(input));
    },
  );

  registerTool(
    "actualizar_cobertura",
    {
      title: "Actualizar cobertura",
      description: "Actualiza solo los campos enviados de una cobertura.",
      inputSchema: { id: z.string().uuid(), ...coverageSchema.partial().shape },
      outputSchema: pressRecordOutputSchema,
      annotations: { destructiveHint: false, idempotentHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["agenda:write"] }] },
    },
    async ({ id, ...patch }, extra) => {
      authFromExtra(extra, "agenda:write", ["admin", "press"]);
      if (!Object.keys(patch).length) throw new Error("Enviá al menos un campo para actualizar la cobertura");
      const coverage = await press.updateCoverage(id, patch);
      if (!coverage) throw new Error("Cobertura no encontrada");
      return textResult(coverage);
    },
  );

  registerTool(
    "eliminar_cobertura",
    {
      title: "Eliminar cobertura",
      description: "Elimina una cobertura registrada.",
      inputSchema: { id: z.string().uuid() },
      outputSchema: pressRemovalOutputSchema,
      annotations: { destructiveHint: true, idempotentHint: false },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["agenda:write"] }] },
    },
    async ({ id }, extra) => {
      authFromExtra(extra, "agenda:write", ["admin", "press"]);
      return textResult({ id, deleted: await press.remove("coverages", id) });
    },
  );

  registerTool(
    "ejecutar_seguimientos_prensa",
    {
      title: "Ejecutar seguimientos de prensa",
      description:
        "Revisa los seguimientos vencidos. Por defecto simula los envíos; indicá dryRun=false para enviar emails reales.",
      inputSchema: { dryRun: z.boolean().default(true) },
      outputSchema: z.object({ results: z.array(z.unknown()) }),
      annotations: { destructiveHint: false, idempotentHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["agenda:write"] }] },
    },
    async ({ dryRun }, extra) => {
      authFromExtra(extra, "agenda:write", ["admin", "press"]);
      return textResult({ results: await press.sendDueFollowups(dryRun) });
    },
  );

  registerTool(
    "crear_busqueda_reemplazo",
    {
      title: "Crear búsqueda de reemplazo",
      description: "Publica una búsqueda interna de reemplazo y valida el evento relacionado cuando se informa.",
      inputSchema: replacementSearchSchema.shape,
      outputSchema: pressRecordOutputSchema,
      annotations: { destructiveHint: false, idempotentHint: false },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["agenda:write"] }] },
    },
    async (input, extra) => {
      authFromExtra(extra, "agenda:write", ["admin", "press"]);
      return textResult(await press.createReplacementSearch(input));
    },
  );

  registerTool(
    "actualizar_busqueda_reemplazo",
    {
      title: "Actualizar búsqueda de reemplazo",
      description: "Actualiza solo los campos enviados de una búsqueda de reemplazo.",
      inputSchema: { id: z.string().uuid(), ...replacementSearchSchema.partial().shape },
      outputSchema: pressRecordOutputSchema,
      annotations: { destructiveHint: false, idempotentHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["agenda:write"] }] },
    },
    async ({ id, ...patch }, extra) => {
      authFromExtra(extra, "agenda:write", ["admin", "press"]);
      if (!Object.keys(patch).length) throw new Error("Enviá al menos un campo para actualizar la búsqueda");
      const search = await press.updateReplacementSearch(id, patch);
      if (!search) throw new Error("Búsqueda de reemplazo no encontrada");
      return textResult(search);
    },
  );

  registerTool(
    "eliminar_busqueda_reemplazo",
    {
      title: "Eliminar búsqueda de reemplazo",
      description: "Elimina una búsqueda solo si no tiene postulaciones vinculadas.",
      inputSchema: { id: z.string().uuid() },
      outputSchema: pressRemovalOutputSchema,
      annotations: { destructiveHint: true, idempotentHint: false },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["agenda:write"] }] },
    },
    async ({ id }, extra) => {
      authFromExtra(extra, "agenda:write", ["admin", "press"]);
      return textResult({ id, deleted: await press.remove("replacementSearches", id) });
    },
  );

  registerTool(
    "listar_postulaciones_reemplazo",
    {
      title: "Listar postulaciones de reemplazo",
      description: "Lista las postulaciones recibidas para una búsqueda de reemplazo específica.",
      inputSchema: { searchId: z.string().uuid() },
      outputSchema: z.object({ applications: z.array(z.unknown()) }),
      annotations: { readOnlyHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["replacements:read"] }] },
    },
    async ({ searchId }, extra) => {
      authFromExtra(extra, "replacements:read", readReplacementsRoles);
      return textResult({ applications: await press.listReplacementApplications(searchId) });
    },
  );

  registerTool(
    "asignar_postulacion_reemplazo",
    {
      title: "Asignar postulación de reemplazo",
      description:
        "Asigna la postulación seleccionada y rechaza las demás. Por defecto simula la notificación; para enviar el correo real se requiere Idempotency-Key.",
      inputSchema: {
        id: z.string().uuid(),
        dryRun: z.boolean().default(true),
        idempotencyKey: mailReplyIdempotencyKeySchema.optional(),
      },
      outputSchema: z.object({ applicationId: z.string(), searchId: z.string(), notification: z.unknown() }),
      annotations: { destructiveHint: false, idempotentHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["agenda:write"] }] },
    },
    async ({ id, dryRun, idempotencyKey }, extra) => {
      const actor = authFromExtra(extra, "agenda:write", ["admin", "press"]);
      if (!dryRun && !idempotencyKey) throw new Error("Para enviar la notificación se necesita Idempotency-Key");
      try {
        const result = await press.assignReplacementApplication(
          id,
          dryRun,
          !dryRun && idempotencyKey ? { key: idempotencyKey, actorId: actor.userId } : undefined,
        );
        return textResult(result);
      } catch (error) {
        if (error instanceof IdempotentOperationError) {
          throw new Error(`${error.message} (outcome=${error.reason})`);
        }
        throw error;
      }
    },
  );

  registerTool(
    "obtener_dossier_prensa",
    {
      title: "Consultar dossier de prensa",
      description: "Devuelve la identidad, audiencia y datos de contacto del medio configurados en Afterstage.",
      inputSchema: {},
      outputSchema: mediaKitSchema,
      annotations: { readOnlyHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["agenda:read"] }] },
    },
    async (_input, extra) => {
      authFromExtra(extra, "agenda:read", readAgendaRoles);
      return textResult((await press.snapshot()).mediaKit);
    },
  );

  registerTool(
    "actualizar_dossier_prensa",
    {
      title: "Actualizar dossier de prensa",
      description: "Actualiza solo los campos enviados del dossier. No publica contenido ni envía comunicaciones.",
      inputSchema: mediaKitSchema.partial().shape,
      outputSchema: mediaKitSchema,
      annotations: { destructiveHint: false, idempotentHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["agenda:write"] }] },
    },
    async (input, extra) => {
      authFromExtra(extra, "agenda:write", ["admin", "press"]);
      if (!Object.keys(input).length) throw new Error("Enviá al menos un campo para actualizar el dossier");
      const mediaKit = await press.updateMediaKit(input);
      return textResult(mediaKit);
    },
  );

  registerTool(
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

  registerTool(
    "crear_contacto",
    {
      title: "Crear entrada de directorio",
      description:
        "Crea una entrada del directorio editorial —banda, artista, medio, sala u organización— con sus contactos y datos de comunicación. Los reintentos idénticos se deduplican; también podés enviar una idempotencyKey estable.",
      inputSchema: { ...directoryInputSchema.shape, idempotencyKey: idempotencyKeySchema.optional() },
      outputSchema: z.object({ id: z.string() }).passthrough(),
      annotations: { destructiveHint: false, idempotentHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["directory:write"] }] },
    },
    async ({ idempotencyKey, ...input }, extra) => {
      const actor = authFromExtra(extra, "directory:write", writeDirectoryRoles);
      const directoryInput = directoryInputSchema.parse(input);
      const secret = process.env.JWT_SECRET;
      if (!secret) throw new Error("No se puede asegurar el reintento de esta operación ahora");
      const requestHash = createHmac("sha256", secret)
        .update(JSON.stringify({ action: "crear_contacto", data: directoryInput }))
        .digest("hex");
      const operationIdentity = idempotencyKey ? `key:${idempotencyKey}` : `payload:${requestHash}`;
      const operationKey = createHash("sha256")
        .update(`mcp-directory-contact:${actor.userId}:${operationIdentity}`)
        .digest("hex");
      const operation = await press.beginIdempotentOperation(operationKey, requestHash);
      if (operation.status === "conflict" || operation.status === "pending")
        throw new IdempotentOperationError(operation.status);
      if (operation.status === "completed") {
        const item = await directory.get((operation.result as { id: string }).id);
        return textResult({ ...item, createdBy: actor.userId, replayed: true });
      }
      const item = await directory.create(directoryInput);
      await press.completeIdempotentOperation(operationKey, { id: item.id });
      return textResult({ ...item, createdBy: actor.userId, replayed: false });
    },
  );

  registerTool(
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

  registerTool(
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

  registerTool(
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
        images: z
          .array(imageInputSchema)
          .max(10)
          .default([])
          .describe("Imágenes para guardar junto con la nota. Enviá cada archivo como base64 o data URL."),
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
      const actor = authFromExtra(extra, "notes:write", writeNotesRoles);
      const note = await manager.createAgentNote(input, actor.userId);
      return textResult({ ...publicNote(note), createdBy: actor.userId });
    },
  );

  registerTool(
    "recompartir_nota_instagram",
    {
      title: "Recompartir nota en Instagram",
      description:
        "Publica en Instagram una nueva versión de una nota ya publicada. Requiere instagram:publish y una clave estable para impedir publicaciones duplicadas al reintentar.",
      inputSchema: {
        id: z.string().trim().min(1).max(180),
        idempotencyKey: idempotencyKeySchema,
      },
      outputSchema: noteOutputSchema,
      annotations: { destructiveHint: false, idempotentHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["instagram:publish"] }] },
    },
    async ({ id, idempotencyKey }, extra) => {
      const actor = authFromExtra(extra, "instagram:publish", ["admin", "editor", "social"]);
      if (
        !actor.roles.includes("admin") &&
        !actor.roles.includes("social") &&
        !actor.permissions.includes("instagram:publish")
      )
        throw new Error("Se requiere el permiso instagram:publish");
      const note = await manager.repostInstagram(id, false, { key: idempotencyKey, actorId: actor.userId });
      return textResult({ ...publicNote(note), updatedBy: actor.userId });
    },
  );

  registerTool(
    "agregar_imagenes_nota",
    {
      title: "Agregar imágenes a una nota",
      description:
        "Adjunta una o más imágenes en base64 a una nota existente. Las imágenes se guardan en el almacenamiento de medios de Afterstage y se agregan al borrador sin publicar automáticamente.",
      inputSchema: {
        id: z.string().trim().min(1).max(180),
        images: z.array(imageInputSchema).min(1).max(10),
      },
      outputSchema: noteMutationOutputSchema,
      annotations: { destructiveHint: false, idempotentHint: false },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["notes:write"] }] },
    },
    async ({ id, images }, extra) => {
      const actor = authFromExtra(extra, "notes:write", writeNotesRoles);
      const note = await manager.addImages(id, images);
      return textResult({ ...publicNote(note), updatedBy: actor.userId });
    },
  );

  registerTool(
    "crear_carrusel_instagram",
    {
      title: "Crear carrusel de Instagram",
      description:
        "Antes de redactar, consultá listar_plantillas_sociales y seguí sus reglas editoriales y la estructura de la plantilla elegida. No inventes datos; si faltan hechos esenciales, pedí fuentes o excluilos. Recibe fotos, texto por lámina, caption, fuente y créditos; renderiza y guarda un borrador con URLs para revisión. Nunca publica automáticamente.",
      inputSchema: instagramCarouselInputSchema.shape,
      outputSchema: carouselOutputSchema,
      annotations: { destructiveHint: false, idempotentHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["notes:write"] }] },
    },
    async (input, extra) => {
      const actor = authFromExtra(extra, "notes:write", writeNotesRoles);
      if (!socialTemplates) throw new Error("Las plantillas sociales no están configuradas");
      const template = await socialTemplates.get(input.templateId);
      if (!template) throw new Error("No se encontró la plantilla seleccionada");
      const note = await manager.createInstagramCarousel(input, actor.userId, template);
      return textResult(publicCarousel(note, actor.userId));
    },
  );

  registerTool(
    "listar_plantillas_sociales",
    {
      title: "Listar plantillas sociales",
      description:
        "Primer paso obligatorio antes de crear una publicación. Devuelve estilos visuales (composición, paleta y formato) por separado de las guías editoriales (temas, propósito, hechos a verificar y estructura narrativa). Elegí un estilo por su visualStyleId y combiná la guía editorial adecuada al tema. No confundas tema con diseño ni inventes datos faltantes.",
      inputSchema: {},
      outputSchema: socialTemplatesOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["notes:read"] }] },
    },
    async (_input, extra) => {
      authFromExtra(extra, "notes:read", readNotesRoles);
      if (!socialTemplates) throw new Error("Las plantillas sociales no están configuradas");
      const catalog = await socialTemplates.list({ status: "published", channel: "instagram" });
      const styleRecords = new Map<string, (typeof catalog)[number]>();
      for (const template of catalog) {
        const key = `${template.outputType}:${template.visualStyle.id}`;
        if (!styleRecords.has(key)) styleRecords.set(key, template);
      }
      const templates = [...styleRecords.values()].map((template) => ({
        id: template.id,
        visualStyleId: template.visualStyle.id,
        outputType: template.outputType,
        name: template.visualStyle.name,
        description: template.visualStyle.description,
        canvas: template.canvas,
        visualStyle: template.visualStyle,
      }));
      const editorialGuides = catalog.map((template) => ({
        templateId: template.id,
        slug: template.slug,
        name: template.name,
        description: template.description,
        editorialSection: template.editorialSection,
        outputType: template.outputType,
        channels: template.channels,
        templateVersion: template.templateVersion,
        guidanceVersion: template.guidanceVersion,
        fields: template.fields,
        slides: template.slides,
        editorialGuidance: template.editorialGuidance,
      }));
      return textResult({
        editorialStandards: socialEditorialStandards,
        templates,
        editorialGuides,
        totalStyles: templates.length,
        totalGuides: editorialGuides.length,
      });
    },
  );

  registerTool(
    "crear_pieza_instagram",
    {
      title: "Crear post o historias de Instagram",
      description:
        "Crea como borrador un post 4:5 o una historia 9:16 a partir de una plantilla visual. Incluí una foto y el texto integrado; Afterstage compone la imagen y devuelve su URL para que puedas revisarla. Nunca publica automáticamente.",
      inputSchema: instagramSocialPublicationInputShape,
      outputSchema: carouselOutputSchema,
      annotations: { destructiveHint: false, idempotentHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["notes:write"] }] },
    },
    async (input, extra) => {
      const actor = authFromExtra(extra, "notes:write", writeNotesRoles);
      if (!socialTemplates) throw new Error("Las plantillas sociales no están configuradas");
      const template = await socialTemplates.get(input.templateId);
      if (!template) throw new Error("No se encontró la plantilla seleccionada");
      const note = await manager.createInstagramSocialPublication(input, actor.userId, template);
      return textResult(publicCarousel(note, actor.userId));
    },
  );

  registerTool(
    "listar_series_sociales",
    {
      title: "Listar series de publicaciones",
      description:
        "Muestra las series de Afterstage. Las series editoriales producen borradores para revisar; las secuencias fijas configuradas para publicación automática publican sus medios en el horario indicado.",
      inputSchema: {},
      outputSchema: socialSeriesOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["notes:read"] }] },
    },
    async (_input, extra) => {
      authFromExtra(extra, "notes:read", readNotesRoles);
      if (!socialSeries || !socialTemplates) throw new Error("La gestión de series sociales no está configurada");
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date());
      const series = await Promise.all(
        (await socialSeries.list()).map(async (item) => {
          const template = await socialTemplates.findBySlug(item.templateSlug);
          return {
            ...item,
            templateName: template?.name ?? "Formato no disponible",
            outputType: template?.outputType ?? "unknown",
            due: Boolean(item.active && item.nextRunAt && item.nextRunAt <= today),
          };
        }),
      );
      return textResult({ series, total: series.length });
    },
  );

  registerTool(
    "crear_serie_social",
    {
      title: "Crear una serie recurrente",
      description:
        "Guarda una serie editorial, que genera borradores manualmente, o una secuencia de tres Stories con publicación automática. La secuencia se renderiza cada día desde sus plantillas SVG editables; requiere frecuencia diaria, permiso instagram:publish y una cuenta de Instagram Business conectada.",
      inputSchema: socialSeriesInputShape,
      outputSchema: socialSeriesMutationOutputSchema,
      annotations: { destructiveHint: false, idempotentHint: false },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["notes:write"] }] },
    },
    async (input, extra) => {
      const actor = authFromExtra(extra, "notes:write", writeNotesRoles);
      if (!socialSeries || !socialTemplates) throw new Error("La gestión de series sociales no está configurada");
      const parsed = socialSeriesSchema.parse(input);
      if (
        parsed.autoPublish &&
        parsed.active &&
        !(
          actor.roles.some((role) => role === "admin" || role === "social") ||
          actor.permissions.includes("instagram:publish")
        )
      ) {
        throw new Error("Se requiere el permiso instagram:publish para activar la publicación automática");
      }
      const template = await socialTemplates.findBySlug(parsed.templateSlug);
      if (!template || template.status !== "published") throw new Error("El formato social no está disponible");
      const series = await socialSeries.save(parsed);
      return textResult({ series });
    },
  );

  registerTool(
    "actualizar_serie_social",
    {
      title: "Actualizar una serie recurrente",
      description:
        "Cambia la frecuencia, el estado o la pauta editorial de una serie. En una secuencia automática, desactivar la serie la pausa; pausar no elimina publicaciones programadas ni anteriores.",
      inputSchema: socialSeriesInputShape,
      outputSchema: socialSeriesMutationOutputSchema,
      annotations: { destructiveHint: false, idempotentHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["notes:write"] }] },
    },
    async (input, extra) => {
      const actor = authFromExtra(extra, "notes:write", writeNotesRoles);
      if (!socialSeries || !socialTemplates) throw new Error("La gestión de series sociales no está configurada");
      const parsed = socialSeriesSchema.parse(input);
      if (!parsed.id) throw new Error("Indicá el id de la serie a actualizar");
      if (
        parsed.autoPublish &&
        parsed.active &&
        !(
          actor.roles.some((role) => role === "admin" || role === "social") ||
          actor.permissions.includes("instagram:publish")
        )
      ) {
        throw new Error("Se requiere el permiso instagram:publish para activar la publicación automática");
      }
      const template = await socialTemplates.findBySlug(parsed.templateSlug);
      if (!template || template.status !== "published") throw new Error("El formato social no está disponible");
      const series = await socialSeries.save(parsed, parsed.id);
      return textResult({ series });
    },
  );

  registerTool(
    "crear_borrador_serie_social",
    {
      title: "Crear borrador desde una serie",
      description:
        "Genera un post, historia o carrusel con el formato asociado a una serie y actualiza su próxima fecha. Adjuntá las imágenes y datos verificados del ciclo; el resultado siempre queda en borrador y no se publica.",
      inputSchema: {
        seriesId: z.string().trim().min(2).max(120),
        title: z.string().trim().min(1).max(180),
        instagramCopy: z.string().trim().min(1).max(2200),
        slides: z
          .array(z.object({ image: imageInputSchema, text: z.string().trim().min(1).max(180) }))
          .min(1)
          .max(9),
        tags: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
        source: z.string().trim().min(1).max(500),
        author: z.string().trim().max(180).default(""),
        photographer: z.string().trim().max(180).default(""),
      },
      outputSchema: carouselOutputSchema,
      annotations: { destructiveHint: false, idempotentHint: false },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["notes:write"] }] },
    },
    async (input, extra) => {
      const actor = authFromExtra(extra, "notes:write", writeNotesRoles);
      if (!socialSeries || !socialTemplates) throw new Error("La gestión de series sociales no está configurada");
      const series = await socialSeries.get(input.seriesId);
      if (!series?.active) throw new Error("La serie está pausada o no existe");
      if (series.autoPublish)
        throw new Error("Esta secuencia se publica automáticamente y no admite borradores manuales");
      const template = await socialTemplates.findBySlug(series.templateSlug);
      if (!template || template.status !== "published") throw new Error("El formato de la serie no está disponible");
      if (template.outputType === "carousel" && input.slides.length < 2)
        throw new Error("El carrusel necesita al menos dos láminas");
      if (template.outputType !== "carousel" && input.slides.length !== 1)
        throw new Error("Este formato usa una sola lámina");
      const content = { ...input, templateId: template.id };
      const draft =
        template.outputType === "carousel"
          ? await manager.createInstagramCarousel(content, actor.userId, template)
          : await manager.createInstagramSocialPublication(
              { ...content, type: template.outputType },
              actor.userId,
              template,
            );
      const updatedSeries = await socialSeries.completeDraftRun(series.id, draft.id);
      return textResult({ ...publicCarousel(draft, actor.userId), seriesNextRunAt: updatedSeries.nextRunAt });
    },
  );

  registerTool(
    "corregir_lamina_instagram",
    {
      title: "Reemplazar imagen de una pieza de Instagram",
      description:
        "Recibe la imagen corregida y reemplaza la lámina indicada de un borrador de carrusel, post o historia. Devuelve las URLs actuales para volver a revisarlas.",
      inputSchema: {
        publicationId: z.string().trim().min(1).max(180),
        slide: z.number().int().positive(),
        image: correctedCarouselImageSchema.shape.image,
      },
      outputSchema: carouselOutputSchema,
      annotations: { destructiveHint: false, idempotentHint: false },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["notes:write"] }] },
    },
    async ({ publicationId, slide, image }, extra) => {
      const actor = authFromExtra(extra, "notes:write", writeNotesRoles);
      if (!socialTemplates) throw new Error("Las plantillas sociales no están configuradas");
      const current = await manager.required(publicationId);
      if (!current.socialTemplateId) throw new Error("El borrador no tiene una plantilla social asociada");
      const template = await socialTemplates.get(current.socialTemplateId);
      if (!template) throw new Error("No se encontró la plantilla del borrador");
      const updated = await manager.replaceInstagramCarouselImage(publicationId, slide, { image }, template);
      return textResult(publicCarousel(updated, actor.userId));
    },
  );

  registerTool(
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
      const actor = authFromExtra(extra, "notes:write", writeNotesRoles);
      if (!Object.keys(patch).length) throw new Error("Enviá al menos un campo para modificar la nota");
      const note = await manager.update(id, patch);
      return textResult({ ...publicNote(note), updatedBy: actor.userId });
    },
  );

  registerTool(
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
      const actor = authFromExtra(extra, "notes:write", writeNotesRoles);
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
      const actor = authFromExtra(extra, "notes:write", writeNotesRoles);
      const note = await manager.update(id, { status });
      return textResult({ ...publicNote(note), updatedBy: actor.userId });
    },
  );

  registerTool(
    "listar_rutas_correo",
    {
      title: "Listar rutas de correo",
      description:
        "Consulta las direcciones de Afterstage y sus destinatarios de reenvío. Una ruta sin destinatarios solo archiva los mensajes en la bandeja de Afterstage.",
      inputSchema: {},
      outputSchema: mailRoutesOutputSchema,
      annotations: { readOnlyHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["mail:read"] }] },
    },
    async (_input, extra) => {
      authFromExtra(extra, "mail:read", readMailRoles);
      if (!mailboxManager) throw new Error("La bandeja de correo no está disponible");
      return textResult({ routes: await mailboxManager.listRoutes() });
    },
  );

  registerTool(
    "listar_blacklist_correo",
    {
      title: "Listar remitentes bloqueados",
      description:
        "Consulta la blacklist de correo de Afterstage. Una lista vacía permite que la aplicación procese cualquier remitente que Cloudflare haya aceptado.",
      inputSchema: {},
      outputSchema: mailBlacklistOutputSchema,
      annotations: { readOnlyHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["mail:read"] }] },
    },
    async (_input, extra) => {
      authFromExtra(extra, "mail:read", readMailRoles);
      if (!mailboxManager) throw new Error("La bandeja de correo no está disponible");
      return textResult({ entries: await mailboxManager.listBlockedSenders() });
    },
  );

  registerTool(
    "actualizar_blacklist_correo",
    {
      title: "Actualizar blacklist de correo",
      description:
        "Reemplaza la blacklist de Afterstage. Acepta emails exactos o dominios con @ (por ejemplo, @ejemplo.com); enviá [] para mantenerla vacía.",
      inputSchema: { entries: z.array(z.string()).max(200) },
      outputSchema: mailBlacklistOutputSchema,
      annotations: { destructiveHint: false, idempotentHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["mail:write"] }] },
    },
    async ({ entries }, extra) => {
      authFromExtra(extra, "mail:write", writeMailRoles);
      if (!mailboxManager) throw new Error("La bandeja de correo no está disponible");
      return textResult({ entries: await mailboxManager.setBlockedSenders(blockedSendersSchema.parse(entries)) });
    },
  );

  registerTool(
    "listar_conversaciones_correo",
    {
      title: "Listar conversaciones de correo",
      description:
        "Lista los mensajes recibidos y enviados en las bandejas de Afterstage, con asunto, participantes, vista previa y dirección de archivo opcional.",
      inputSchema: {
        mailbox: z.string().trim().email().optional(),
        limit: z.number().int().min(1).max(100).default(50),
      },
      outputSchema: z.object({ conversations: z.array(mailThreadSummaryOutputSchema) }),
      annotations: { readOnlyHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["mail:read"] }] },
    },
    async ({ mailbox, limit }, extra) => {
      authFromExtra(extra, "mail:read", readMailRoles);
      if (!mailboxManager) throw new Error("La bandeja de correo no está disponible");
      const conversations = (await mailboxManager.listThreads())
        .filter((thread) => !mailbox || thread.mailbox?.toLowerCase() === mailbox.toLowerCase())
        .slice(0, limit);
      return textResult({ conversations });
    },
  );

  registerTool(
    "leer_conversacion_correo",
    {
      title: "Leer conversación de correo",
      description:
        "Lee el contenido completo de una conversación, incluidos los cuerpos de texto y HTML de cada mensaje.",
      inputSchema: { id: z.string().trim().min(1).max(180) },
      outputSchema: z.object({ conversation: mailThreadOutputSchema }),
      annotations: { readOnlyHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["mail:read"] }] },
    },
    async ({ id }, extra) => {
      authFromExtra(extra, "mail:read", readMailRoles);
      if (!mailboxManager) throw new Error("La bandeja de correo no está disponible");
      const conversation = await mailboxManager.readThread(id);
      if (!conversation) throw new Error("Conversación no encontrada");
      return textResult({ conversation });
    },
  );

  registerTool(
    "responder_conversacion_correo",
    {
      title: "Responder una conversación de correo",
      description:
        "Envía una respuesta a una conversación de Afterstage. Reutilizá la misma idempotencyKey si repetís exactamente la misma solicitud; una clave con otro contenido se rechaza.",
      inputSchema: {
        id: z.string().trim().min(1).max(180),
        ...mailReplySchema.shape,
        idempotencyKey: mailReplyIdempotencyKeySchema,
      },
      outputSchema: z.object({ message: mailMessageOutputSchema }),
      annotations: { destructiveHint: false, idempotentHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["mail:reply"] }] },
    },
    async ({ id, text, html, idempotencyKey }, extra) => {
      const actor = authFromExtra(extra, "mail:reply", replyMailRoles);
      if (!mailboxManager) throw new Error("La gestión del correo no está configurada");
      try {
        const message = await mailboxManager.reply(
          id,
          { text, ...(html !== undefined ? { html } : {}) },
          { key: idempotencyKey, actorId: actor.userId },
        );
        return textResult({ message });
      } catch (error) {
        if (error instanceof IdempotentOperationError) {
          return {
            content: [{ type: "text" as const, text: error.message }],
            isError: true,
            structuredContent: { error: error.message, outcome: error.reason },
          };
        }
        throw error;
      }
    },
  );

  registerTool(
    "crear_ruta_correo",
    {
      title: "Crear ruta de correo",
      description:
        "Crea una dirección grupal de Afterstage. Dejá destinations vacío para guardar los mensajes solo en la bandeja interna, sin reenviarlos.",
      inputSchema: {
        address: z.string().trim().email().max(180),
        label: z.string().trim().min(1).max(80),
        kind: z.enum(["personal", "distribution"]).default("distribution"),
        destinations: z.array(z.string().trim().email().max(180)).max(50).default([]),
      },
      outputSchema: z.object({ route: mailRouteOutputSchema }),
      annotations: { destructiveHint: false, idempotentHint: false },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["mail:write"] }] },
    },
    async (input, extra) => {
      authFromExtra(extra, "mail:write", writeMailRoles);
      if (!mailboxManager) throw new Error("La bandeja de correo no está disponible");
      return textResult({ route: await mailboxManager.createRoute(mailRouteInputSchema.parse(input)) });
    },
  );

  registerTool(
    "actualizar_ruta_correo",
    {
      title: "Actualizar ruta de correo",
      description:
        "Actualiza una ruta existente. Enviá destinations como [] para dejarla en modo archivo interno sin reenvíos.",
      inputSchema: {
        address: z.string().trim().email().max(180),
        label: z.string().trim().min(1).max(80).optional(),
        kind: z.enum(["personal", "distribution"]).optional(),
        destinations: z.array(z.string().trim().email().max(180)).max(50).optional(),
      },
      outputSchema: z.object({ route: mailRouteOutputSchema }),
      annotations: { destructiveHint: false, idempotentHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["mail:write"] }] },
    },
    async ({ address, ...patch }, extra) => {
      authFromExtra(extra, "mail:write", writeMailRoles);
      if (!mailboxManager) throw new Error("La bandeja de correo no está disponible");
      const parsed = mailRoutePatchSchema.parse(patch);
      if (!Object.keys(parsed).length) throw new Error("Enviá al menos un campo para actualizar la ruta");
      const route = await mailboxManager.updateRoute(address, parsed);
      if (!route) throw new Error("Ruta de correo no encontrada");
      return textResult({ route });
    },
  );

  registerTool(
    "eliminar_ruta_correo",
    {
      title: "Eliminar ruta de correo",
      description:
        "Elimina una dirección grupal. Los mensajes futuros enviados a esa dirección dejarán de procesarse por esa ruta.",
      inputSchema: { address: z.string().trim().email().max(180) },
      outputSchema: z.object({ address: z.string(), deleted: z.literal(true) }),
      annotations: { destructiveHint: true, idempotentHint: false },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["mail:write"] }] },
    },
    async ({ address }, extra) => {
      authFromExtra(extra, "mail:write", writeMailRoles);
      if (!mailboxManager) throw new Error("La bandeja de correo no está disponible");
      if (!(await mailboxManager.deleteRoute(address))) throw new Error("Ruta de correo no encontrada");
      return textResult({ address: address.trim().toLowerCase(), deleted: true });
    },
  );

  registerTool(
    "obtener_estado_plataforma",
    {
      title: "Consultar operaciones de plataforma",
      description:
        "Devuelve el estado de perfiles, búsquedas, postulaciones, traslados, seguros, conversaciones y catálogo. Los datos personales se omiten salvo que includePersonalData sea true y la cuenta tenga rol admin.",
      inputSchema: { includePersonalData: z.boolean().default(false) },
      outputSchema: z.object({ snapshot: z.unknown() }),
      annotations: { readOnlyHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["platform:read"] }] },
    },
    async ({ includePersonalData }, extra) => {
      const actor = authFromExtra(extra, "platform:read", ["admin", "editor", "press", "community", "auditor"]);
      const snapshot = await platform.snapshot();
      const canReadPersonalData = includePersonalData && actor.roles.includes("admin");
      if (canReadPersonalData) return textResult({ snapshot });
      return textResult({
        snapshot: {
          ...snapshot,
          photographers: snapshot.photographers.map(
            ({ id, name, city, specialties, status, createdAt, updatedAt }) => ({
              id,
              name,
              city,
              specialties,
              status,
              createdAt,
              updatedAt,
            }),
          ),
          coverageRequests: snapshot.coverageRequests.map(
            ({ id, eventId, title, city, deadlineAt, status, createdAt, updatedAt }) => ({
              id,
              eventId,
              title,
              city,
              deadlineAt,
              status,
              createdAt,
              updatedAt,
            }),
          ),
          coverageApplications: snapshot.coverageApplications.map(
            ({ id, requestId, photographerId, status, createdAt, updatedAt }) => ({
              id,
              requestId,
              photographerId,
              status,
              createdAt,
              updatedAt,
            }),
          ),
          transportRequests: snapshot.transportRequests.map(
            ({ id, eventId, offerId, partySize, status, createdAt, updatedAt }) => ({
              id,
              eventId,
              offerId,
              partySize,
              status,
              createdAt,
              updatedAt,
            }),
          ),
          insuranceRequests: snapshot.insuranceRequests.map(
            ({ id, eventId, coverageType, coverageTypes, startsAt, endsAt, status, createdAt, updatedAt }) => ({
              id,
              eventId,
              coverageType,
              coverageTypes,
              startsAt,
              endsAt,
              status,
              createdAt,
              updatedAt,
            }),
          ),
          forumThreads: snapshot.forumThreads.map(({ id, eventId, title, status, createdAt, updatedAt }) => ({
            id,
            eventId,
            title,
            status,
            createdAt,
            updatedAt,
          })),
          forumPosts: snapshot.forumPosts.map(({ id, threadId, status, createdAt, updatedAt }) => ({
            id,
            threadId,
            status,
            createdAt,
            updatedAt,
          })),
        },
      });
    },
  );

  registerTool(
    "gestionar_operacion_plataforma",
    {
      title: "Gestionar operación de plataforma",
      description:
        "Crea y actualiza perfiles, búsquedas, postulaciones, traslados, seguros, conversaciones y elementos del catálogo. Las altas aceptan idempotencyKey; si se omite, el servidor deduplica por usuario, acción y datos normalizados. El servidor valida los datos con el esquema de dominio y limita cada acción por rol.",
      inputSchema: {
        action: z.enum([
          "create_photographer",
          "create_coverage_request",
          "create_coverage_application",
          "create_transport_offer",
          "create_transport_request",
          "create_insurance_request",
          "create_forum_thread",
          "create_forum_post",
          "create_marketplace_listing",
          "update_photographer",
          "update_coverage_request",
          "update_coverage_application",
          "update_transport_offer",
          "update_transport_request",
          "update_insurance_request",
          "update_forum_thread",
          "update_forum_post",
          "update_marketplace_listing",
        ]),
        resourceId: z.string().uuid().optional(),
        data: z.record(z.string(), z.unknown()).default({}),
        idempotencyKey: idempotencyKeySchema.optional(),
      },
      outputSchema: z.object({ item: z.unknown() }),
      annotations: { destructiveHint: false, idempotentHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["platform:write"] }] },
    },
    async ({ action, resourceId, data, idempotencyKey }, extra) => {
      const actor = authFromExtra(extra, "platform:write");
      const allowedRoles: Record<string, readonly string[]> = {
        create_photographer: ["admin", "editor", "directory"],
        create_coverage_request: ["admin", "editor", "press", "community"],
        create_coverage_application: ["admin", "editor", "press", "community"],
        create_transport_offer: ["admin", "editor", "community"],
        create_transport_request: ["admin", "editor", "community"],
        create_insurance_request: ["admin", "editor", "press", "community"],
        create_forum_thread: ["admin", "editor", "community"],
        create_forum_post: ["admin", "editor", "community"],
        create_marketplace_listing: ["admin", "editor"],
        update_photographer: ["admin", "editor", "directory"],
        update_coverage_request: ["admin", "editor", "press", "community"],
        update_coverage_application: ["admin", "editor", "press", "community"],
        update_transport_offer: ["admin", "editor", "community"],
        update_transport_request: ["admin", "editor", "community"],
        update_insurance_request: ["admin", "editor", "press", "community"],
        update_forum_thread: ["admin", "editor", "community"],
        update_forum_post: ["admin", "editor", "community"],
        update_marketplace_listing: ["admin", "editor"],
      };
      if (!allowedRoles[action]?.some((role) => actor.roles.includes(role))) {
        throw new Error("Tu usuario no tiene permiso para esta operación de plataforma");
      }
      const createAction = action.startsWith("create_");
      let normalizedInput: unknown;
      if (createAction) {
        switch (action) {
          case "create_photographer":
            normalizedInput = photographerProfileSchema.parse({ ...data, status: "pending" });
            break;
          case "create_coverage_request":
            normalizedInput = coverageRequestSchema.parse({ ...data, status: "open" });
            break;
          case "create_coverage_application":
            normalizedInput = coverageApplicationSchema.parse({ ...data, status: "pending" });
            break;
          case "create_transport_offer":
            normalizedInput = transportOfferSchema.parse({ ...data, status: "open" });
            break;
          case "create_transport_request":
            normalizedInput = transportRequestSchema.parse({ ...data, status: "new" });
            break;
          case "create_insurance_request":
            normalizedInput = insuranceRequestSchema.parse({ ...data, status: "new" });
            break;
          case "create_forum_thread":
            normalizedInput = forumThreadSchema.parse({ ...data, status: "visible" });
            break;
          case "create_forum_post":
            normalizedInput = forumPostSchema.parse({ ...data, status: "visible" });
            break;
          case "create_marketplace_listing":
            normalizedInput = marketplaceListingSchema.parse(data);
            break;
        }
      }
      const requireId = () => {
        if (!resourceId) throw new Error("Falta el ID del recurso");
        return resourceId;
      };
      let operationKey: string | undefined;
      if (createAction) {
        const secret = process.env.JWT_SECRET;
        if (!secret) throw new Error("No se puede asegurar el reintento de esta operación ahora");
        const requestHash = createHmac("sha256", secret)
          .update(JSON.stringify({ action, data: normalizedInput }))
          .digest("hex");
        const requestIdentity = idempotencyKey ?? requestHash;
        operationKey = createHash("sha256")
          .update(`mcp-platform:${actor.userId}:${action}:${requestIdentity}`)
          .digest("hex");
        const operation = await press.beginIdempotentOperation(operationKey, requestHash);
        if (operation.status === "conflict" || operation.status === "pending")
          throw new IdempotentOperationError(operation.status);
        if (operation.status === "completed") return textResult({ item: operation.result as Record<string, unknown> });
      }
      let item: unknown;
      switch (action) {
        case "create_photographer":
          item = await platform.createPhotographer(normalizedInput);
          break;
        case "create_coverage_request":
          item = await platform.createCoverageRequest(normalizedInput);
          break;
        case "create_coverage_application":
          item = await platform.createCoverageApplication(normalizedInput);
          break;
        case "create_transport_offer":
          item = await platform.createTransportOffer(normalizedInput);
          break;
        case "create_transport_request":
          item = await platform.createTransportRequest(normalizedInput);
          break;
        case "create_insurance_request":
          item = await platform.createInsuranceRequest(normalizedInput);
          break;
        case "create_forum_thread":
          item = await platform.createForumThread(normalizedInput);
          break;
        case "create_forum_post":
          item = await platform.createForumPost(normalizedInput);
          break;
        case "create_marketplace_listing":
          item = await platform.createMarketplaceListing(normalizedInput);
          break;
        case "update_photographer":
          item = await platform.updatePhotographer(requireId(), data);
          break;
        case "update_coverage_request":
          item = await platform.updateCoverageRequest(requireId(), data);
          break;
        case "update_coverage_application":
          item = await platform.updateCoverageApplication(requireId(), data);
          break;
        case "update_transport_offer":
          item = await platform.updateTransportOffer(requireId(), data);
          break;
        case "update_transport_request":
          item = await platform.updateTransportRequest(requireId(), data);
          break;
        case "update_insurance_request":
          item = await platform.updateInsuranceRequest(requireId(), data);
          break;
        case "update_forum_thread":
          item = await platform.updateForumThread(requireId(), data);
          break;
        case "update_forum_post":
          item = await platform.updateForumPost(requireId(), data);
          break;
        case "update_marketplace_listing":
          item = await platform.updateMarketplaceListing(requireId(), data);
          break;
      }
      if (!item) throw new Error("El recurso de plataforma no existe");
      if (createAction) {
        const resource = item as { id?: string; status?: string; active?: boolean };
        const minimalItem = {
          id: resource.id,
          ...(resource.status ? { status: resource.status } : {}),
          ...(typeof resource.active === "boolean" ? { active: resource.active } : {}),
        };
        await press.completeIdempotentOperation(operationKey!, minimalItem);
        return textResult({ item: minimalItem });
      }
      return textResult({ item, operatedBy: actor.userId });
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
  editorialVoice?: EditorialVoiceRepository,
  socialTemplates?: SocialTemplateRepository,
  mailbox?: MailRepository,
  instagramTrustedCollaborators?: InstagramTrustedCollaboratorStore,
  instagramConnections?: InstagramConnectionStore,
  socialSeries?: SocialSeriesRepository,
  platform: PlatformManager = new PlatformManager(),
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
      issuer: publicUrl.href,
      // The authorization flow currently guarantees `iss` on successful
      // approvals, but not on every possible OAuth error response. Do not
      // advertise RFC 9207 issuer identification until that guarantee is
      // complete; ChatGPT will use the callback-specific redirect instead.
      authorization_response_iss_parameter_supported: false,
    });
  });
  app.get("/.well-known/oauth-protected-resource/mcp", (_request, response) => {
    response.json({
      resource: resourceUrl.href,
      authorization_servers: [publicUrl.href],
      scopes_supported: [...mcpScopes],
      resource_name: "Afterstage",
      resource_documentation: new URL("/politica-editorial", publicUrl).href,
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
  // Some MCP clients probe the origin-level RFC 9728 path before trying the
  // resource-specific `/mcp` path. Keep both discovery URLs equivalent.
  app.get("/.well-known/oauth-protected-resource", (_request, response) => {
    response.json({
      resource: resourceUrl.href,
      authorization_servers: [publicUrl.href],
      scopes_supported: [...mcpScopes],
      resource_name: "Afterstage",
      resource_documentation: new URL("/politica-editorial", publicUrl).href,
    });
  });
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
      const roles = Array.isArray(request.auth?.extra?.roles)
        ? request.auth.extra.roles.filter((role): role is string => typeof role === "string")
        : [];
      const server = createRemoteMcpServer(
        manager,
        press,
        directory,
        roles,
        editorialVoice,
        socialTemplates,
        mailbox,
        instagramTrustedCollaborators,
        instagramConnections,
        socialSeries,
        platform,
        (request as typeof request & { correlationId?: string }).correlationId,
      );
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      next(error);
    }
  });

  return provider;
};
