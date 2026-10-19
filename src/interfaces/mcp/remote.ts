import cors from "cors";
import express, { type Express } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { OAuthError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { z } from "zod";
import { ContentManager } from "../../application/content-manager.js";
import { channels } from "../../domain/content/types.js";
import { McpOAuthProvider, mcpScopes, type McpScope, type McpOAuthStore } from "./oauth.js";
import type { UserDirectory } from "../http/security.js";

const authFromExtra = (
  extra: { authInfo?: { scopes: string[]; extra?: Record<string, unknown> } },
  scope: McpScope,
) => {
  if (!extra.authInfo?.scopes.includes(scope)) throw new Error(`Se requiere el scope ${scope}`);
  const userId = typeof extra.authInfo.extra?.userId === "string" ? extra.authInfo.extra.userId : "";
  if (!userId) throw new Error("La identidad del usuario no está disponible");
  return {
    userId,
    roles: Array.isArray(extra.authInfo.extra?.roles) ? extra.authInfo.extra.roles : [],
    permissions: Array.isArray(extra.authInfo.extra?.permissions) ? extra.authInfo.extra.permissions : [],
  };
};

const textResult = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>,
});

export const createRemoteMcpServer = (manager: ContentManager) => {
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
        status: z.enum(["idea", "draft", "review", "approved", "scheduled", "published", "failed"]).optional(),
      },
      annotations: { readOnlyHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["notes:read"] }] },
    },
    async ({ query, status }, extra) => {
      authFromExtra(extra, "notes:read");
      return textResult(await manager.search(query, status));
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
          identifier: z.string().min(1).max(180),
          password: z.string().min(1).max(200),
        })
        .parse(request.body);
      await provider.approveAuthorization(input.request_id, input.identifier, input.password, response);
    } catch (error) {
      if (error instanceof OAuthError) {
        response
          .status(400)
          .type("html")
          .send(`<p>No se pudo autorizar la conexión.</p><p><a href="javascript:history.back()">Volver</a></p>`);
        return;
      }
      next(error);
    }
  });

  app.all("/mcp", cors(), auth, async (request, response, next) => {
    try {
      const server = createRemoteMcpServer(manager);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      next(error);
    }
  });

  return provider;
};
