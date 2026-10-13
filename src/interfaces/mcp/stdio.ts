import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createManagers } from "../../infrastructure/persistence/mongo.js";
import { channels, contentStatuses, contentTypes } from "../../domain/content/types.js";
import {
  accreditationStatuses,
  contactTypes,
  eventStatuses,
  replacementProfiles,
  replacementStatuses,
} from "../../domain/press/types.js";
import {
  directoryKinds,
  directoryStatuses,
  socialLinksPatchSchema,
  socialLinksSchema,
} from "../../domain/directory/types.js";

const { persistence, manager, press, directory } = await createManagers();
const server = new McpServer({ name: "medio-under", version: "0.1.0" });
const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

server.tool(
  "listar_contenidos",
  "Lista notas y publicaciones del calendario editorial, opcionalmente filtradas por estado.",
  { status: z.enum(contentStatuses).optional() },
  async ({ status }) => json(await manager.store.list(status)),
);
server.tool(
  "obtener_metricas_instagram",
  "Obtiene el resumen agregado de métricas de Instagram persistidas.",
  {},
  async () => json(await manager.instagramMetrics()),
);
server.tool(
  "actualizar_metricas_instagram",
  "Consulta los insights de una publicación de Instagram y los guarda en el contenido. Usa dryRun=true para probar el flujo.",
  { id: z.string().uuid(), dryRun: z.boolean().default(true) },
  async ({ id, dryRun }) => json(await manager.refreshInstagramMetrics(id, dryRun)),
);

server.tool(
  "buscar_contexto_editorial",
  "Busca contenidos, fuentes y créditos existentes para dar contexto verificable a una nota.",
  {
    query: z.string().min(1).max(300),
    status: z.enum(contentStatuses).optional(),
  },
  async ({ query, status }) => json(await manager.search(query, status)),
);

server.tool(
  "listar_prensa",
  "Lista eventos, contactos, solicitudes de acreditación y coberturas de Medio Under.",
  {},
  async () => json(await press.snapshot()),
);

server.tool(
  "buscar_directorio",
  "Busca bandas, artistas, managers, salas, bares, festivales, sellos y agencias.",
  { query: z.string().default("") },
  async ({ query }) => json(await directory.list(query)),
);
server.tool(
  "crear_entrada_directorio",
  "Crea una entrada con redes, teléfonos, emails e integrantes o contactos.",
  {
    kind: z.enum(directoryKinds),
    name: z.string().min(1).max(180),
    aliases: z.array(z.string()).default([]),
    description: z.string().default(""),
    city: z.string().default(""),
    country: z.string().default("Argentina"),
    website: z.string().url().or(z.literal("")).default(""),
    socials: socialLinksSchema.prefault({}),
    phones: z.array(z.string()).default([]),
    emails: z.array(z.string().email()).default([]),
    contacts: z
      .array(
        z.object({
          name: z.string(),
          role: z.string().default(""),
          email: z.string().email().or(z.literal("")).default(""),
          phone: z.string().default(""),
          socials: socialLinksSchema.prefault({}),
          notes: z.string().default(""),
        }),
      )
      .default([]),
    tags: z.array(z.string()).default([]),
    notes: z.string().default(""),
    source: z.string().default(""),
    status: z.enum(directoryStatuses).default("active"),
  },
  async (input) => json(await directory.create(input)),
);
server.tool(
  "actualizar_entrada_directorio",
  "Actualiza una entrada del directorio.",
  {
    id: z.string().uuid(),
    name: z.string().min(1).optional(),
    kind: z.enum(directoryKinds).optional(),
    description: z.string().optional(),
    city: z.string().optional(),
    website: z.string().url().or(z.literal("")).optional(),
    socials: socialLinksPatchSchema.optional(),
    phones: z.array(z.string()).optional(),
    emails: z.array(z.string().email()).optional(),
    contacts: z
      .array(
        z.object({
          name: z.string(),
          role: z.string().default(""),
          email: z.string().email().or(z.literal("")).default(""),
          phone: z.string().default(""),
          socials: socialLinksSchema.prefault({}),
          notes: z.string().default(""),
        }),
      )
      .optional(),
    tags: z.array(z.string()).optional(),
    status: z.enum(directoryStatuses).optional(),
  },
  async ({ id, ...patch }) => json(await directory.update(id, patch)),
);

server.tool(
  "crear_evento",
  "Registra un recital o evento al que Medio Under puede pedir acreditación o que ya cubrió.",
  {
    name: z.string().min(1).max(180),
    artist: z.string().max(180).default(""),
    venue: z.string().max(180).default(""),
    city: z.string().max(120).default(""),
    startsAt: z.string().datetime().nullable().default(null),
    status: z.enum(eventStatuses).default("planned"),
    organizerContactId: z.string().uuid().nullable().default(null),
    url: z.string().url().default(""),
    notes: z.string().default(""),
  },
  async (input) => json(await press.createEvent(input)),
);

server.tool(
  "crear_contacto_prensa",
  "Guarda una productora, sala, sello, agencia o responsable de prensa.",
  {
    name: z.string().min(1).max(180),
    organization: z.string().max(180).default(""),
    type: z.enum(contactTypes).default("press"),
    email: z.string().email().or(z.literal("")).default(""),
    phone: z.string().default(""),
    instagram: z.string().default(""),
    website: z.string().url().default(""),
    notes: z.string().default(""),
  },
  async (input) => json(await press.createContact(input)),
);

server.tool(
  "crear_solicitud_acreditacion",
  "Prepara una solicitud de pase de prensa vinculada a un evento y contacto. No envía el correo automáticamente.",
  {
    eventId: z.string().uuid(),
    contactId: z.string().uuid().nullable().default(null),
    subject: z.string().min(1).max(220),
    message: z.string().default(""),
    status: z.enum(accreditationStatuses).default("draft"),
    sentAt: z.string().datetime().nullable().default(null),
    followUpAt: z.string().datetime().nullable().default(null),
    response: z.string().default(""),
    deliverables: z.string().default("Nota, fotos y publicación en redes"),
  },
  async (input) => json(await press.createAccreditation(input)),
);

server.tool(
  "actualizar_solicitud_acreditacion",
  "Actualiza el estado y seguimiento de una solicitud de prensa.",
  {
    id: z.string().uuid(),
    status: z.enum(accreditationStatuses).optional(),
    sentAt: z.string().datetime().nullable().optional(),
    followUpAt: z.string().datetime().nullable().optional(),
    response: z.string().optional(),
    message: z.string().optional(),
  },
  async ({ id, ...patch }) => json(await press.updateAccreditation(id, patch)),
);

server.tool(
  "enviar_solicitud_acreditacion",
  "Envía por SMTP una solicitud preparada. Usa dryRun=true por defecto para revisar destinatario y asunto sin enviar correo.",
  { id: z.string().uuid(), dryRun: z.boolean().default(true) },
  async ({ id, dryRun }) => {
    if (!dryRun && process.env.MCP_ALLOW_LIVE_EMAIL !== "true")
      throw new Error("El envío real desde MCP requiere MCP_ALLOW_LIVE_EMAIL=true");
    return json(await press.sendAccreditation(id, dryRun));
  },
);

server.tool(
  "enviar_followups_prensa",
  "Envía los seguimientos de acreditación vencidos usando la identidad de Medio Under.",
  { dryRun: z.boolean().default(true) },
  async ({ dryRun }) => {
    if (!dryRun && process.env.MCP_ALLOW_LIVE_EMAIL !== "true")
      throw new Error("El envío real desde MCP requiere MCP_ALLOW_LIVE_EMAIL=true");
    return json(await press.sendDueFollowups(dryRun));
  },
);

server.tool(
  "registrar_cobertura",
  "Registra una nota, galería o publicación realizada sobre un evento para usarla como prueba en futuras acreditaciones.",
  {
    eventId: z.string().uuid().nullable().default(null),
    contentId: z.string().uuid().nullable().default(null),
    title: z.string().min(1).max(220),
    url: z.string().url().default(""),
    publishedAt: z.string().datetime().nullable().default(null),
    reach: z.number().int().nonnegative().default(0),
    notes: z.string().default(""),
  },
  async (input) => json(await press.createCoverage(input)),
);

server.tool(
  "crear_busqueda_reemplazo",
  "Publica una búsqueda estructurada para cubrir un evento cuando un fotógrafo o notero no puede asistir.",
  {
    eventId: z.string().uuid().nullable().default(null),
    title: z.string().min(3).max(220),
    profile: z.enum(replacementProfiles),
    description: z.string().default(""),
    startsAt: z.string().datetime().nullable().default(null),
    city: z.string().default(""),
    latitude: z.number().min(-90).max(90).nullable().default(null),
    longitude: z.number().min(-180).max(180).nullable().default(null),
    requirements: z.string().default(""),
    compensation: z.string().default(""),
    contactEmail: z.string().email(),
    deadlineAt: z.string().datetime().nullable().default(null),
    status: z.enum(replacementStatuses).default("open"),
  },
  async (input) => json(await press.createReplacementSearch(input)),
);
server.tool(
  "listar_postulaciones_reemplazo",
  "Lista postulaciones recibidas para una búsqueda.",
  { searchId: z.string().uuid() },
  async ({ searchId }) => json(await press.listReplacementApplications(searchId)),
);
server.tool(
  "asignar_reemplazo",
  "Asigna un candidato, rechaza los demás y notifica por email. Usa dryRun=true por defecto.",
  { applicationId: z.string().uuid(), dryRun: z.boolean().default(true) },
  async ({ applicationId, dryRun }) => {
    if (!dryRun && process.env.MCP_ALLOW_LIVE_EMAIL !== "true")
      throw new Error("El envío real desde MCP requiere MCP_ALLOW_LIVE_EMAIL=true");
    return json(await press.assignReplacementApplication(applicationId, dryRun));
  },
);

server.tool(
  "obtener_dossier_de_prensa",
  "Obtiene el dossier y archivo de coberturas que se puede compartir con productoras y salas.",
  {},
  async () => {
    const snapshot = await press.snapshot();
    return json({
      mediaKit: snapshot.mediaKit,
      events: snapshot.events.filter((event) => event.status === "covered"),
      coverages: snapshot.coverages.filter((coverage) => coverage.url),
    });
  },
);

server.tool(
  "actualizar_dossier_de_prensa",
  "Actualiza misión, audiencia, equipo, servicios y datos de contacto del dossier público.",
  {
    name: z.string().max(180).optional(),
    tagline: z.string().max(300).optional(),
    mission: z.string().max(4000).optional(),
    audience: z.string().max(2000).optional(),
    team: z.string().max(4000).optional(),
    services: z.string().max(2000).optional(),
    email: z.string().email().or(z.literal("")).optional(),
    website: z.string().url().or(z.literal("")).optional(),
    instagram: z.string().max(120).optional(),
  },
  async (input) => json(await press.updateMediaKit(input)),
);

server.tool(
  "obtener_contenido",
  "Obtiene una nota o publicación completa por ID.",
  { id: z.string().uuid() },
  async ({ id }) => json(await manager.required(id)),
);

server.tool(
  "crear_contenido",
  "Crea una nota o publicación como idea o borrador. No publica en redes.",
  {
    title: z.string().min(1).max(180),
    type: z.enum(contentTypes).default("article"),
    summary: z.string().max(600).default(""),
    body: z.string().default(""),
    status: z.enum(["idea", "draft"]).default("draft"),
    channels: z.array(z.enum(channels)).default(["website", "instagram"]),
    tags: z.array(z.string()).default([]),
  },
  async (input) => json(await manager.create(input)),
);

server.tool(
  "editar_contenido",
  "Edita campos editoriales de un contenido existente. Respeta las transiciones de estado del flujo.",
  {
    id: z.string().uuid(),
    title: z.string().min(1).max(180).optional(),
    summary: z.string().max(600).optional(),
    body: z.string().optional(),
    instagramCopy: z.string().max(2200).optional(),
    facebookCopy: z.string().optional(),
    status: z.enum(["idea", "draft", "review", "approved", "scheduled"]).optional(),
    scheduledAt: z.string().datetime().nullable().optional(),
  },
  async ({ id, ...patch }) => json(await manager.update(id, patch)),
);

server.tool(
  "generar_con_ia",
  "Genera o mejora una nota o sus copys sociales. El resultado queda guardado como borrador y nunca se publica automáticamente.",
  {
    id: z.string().uuid(),
    kind: z.enum(["full_article", "social_copy", "improve"]),
    instructions: z.string().max(2000).default(""),
  },
  async ({ id, kind, instructions }) => json(await manager.generate(id, kind, instructions)),
);

server.tool(
  "publicar_contenido",
  "Publica un contenido previamente aprobado en Meta. Usá dryRun=true para validar el flujo sin enviarlo.",
  { id: z.string().uuid(), dryRun: z.boolean().default(true) },
  async ({ id, dryRun }) => {
    if (!dryRun && process.env.MCP_ALLOW_LIVE_PUBLISH !== "true")
      throw new Error("La publicación real desde MCP requiere MCP_ALLOW_LIVE_PUBLISH=true");
    return json(await manager.publish(id, dryRun));
  },
);

await server.connect(new StdioServerTransport());
process.once("SIGINT", () => void persistence?.client.close());
process.once("SIGTERM", () => void persistence?.client.close());
