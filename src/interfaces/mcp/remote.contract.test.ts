import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ContentManager } from "../../application/content-manager.js";
import { DirectoryManager } from "../../application/directory-manager.js";
import { PressManager } from "../../application/press-manager.js";
import { ContentStore } from "../../infrastructure/persistence/content-store.js";
import { DirectoryStore } from "../../infrastructure/persistence/directory-store.js";
import { PressStore } from "../../infrastructure/persistence/press-store.js";
import { createRemoteMcpServer } from "./remote.js";

const authInfo = (roles: string[]) => ({
  token: "test-token",
  clientId: "test-client",
  scopes: [
    "notes:read",
    "notes:write",
    "agenda:read",
    "agenda:write",
    "directory:read",
    "directory:write",
    "replacements:read",
  ],
  extra: { userId: "editor-1", roles, permissions: [] },
});

test("expone contratos de salida como objetos y aplica filtros, límites y roles MCP", async (context) => {
  const directoryPath = await mkdtemp(path.join(os.tmpdir(), "afterstage-mcp-contract-"));
  context.after(() => rm(directoryPath, { recursive: true, force: true }));

  const manager = new ContentManager(new ContentStore(directoryPath));
  const press = new PressManager(new PressStore(directoryPath));
  const directory = new DirectoryManager(new DirectoryStore(directoryPath));

  const firstNote = await manager.create({ title: "Primera nota", body: "Contenido verificable" });
  await manager.create({ title: "Segunda nota", body: "Otro contenido verificable" });
  await press.createEvent({
    name: "Festival de prueba",
    artist: "Banda de prueba",
    city: "CABA",
    startsAt: "2026-11-01T20:00:00.000Z",
  });
  const replacement = await press.createReplacementSearch({
    title: "Fotógrafo para cobertura",
    profile: "photographer",
    city: "CABA",
    contactEmail: "redaccion@example.com",
  });
  await press.createReplacementApplication({
    searchId: replacement.id,
    applicantName: "Fotógrafa de prueba",
    applicantEmail: "foto@example.com",
    profile: "photographer",
  });
  await directory.create({
    kind: "band",
    name: "Banda de prueba",
    city: "CABA",
    emails: ["banda@example.com"],
    phones: ["+54 11 5555-0000"],
    contacts: [{ name: "Manager de prueba", email: "manager@example.com" }],
  });

  const server = createRemoteMcpServer(manager, press, directory);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let currentAuth = authInfo(["editor"]);
  const send = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) => send(message, { ...options, authInfo: currentAuth });
  await server.connect(serverTransport);
  const client = new Client({ name: "contract-test-client", version: "1.0.0" });
  await client.connect(clientTransport);

  try {
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      [
        "actualizar_nota",
        "cambiar_estado_nota",
        "crear_contacto",
        "crear_nota",
        "crear_evento",
        "buscar_directorio",
        "consultar_borradores",
        "gestionar_acreditacion",
        "get_profile",
        "listar_agenda",
        "listar_notas",
        "listar_reemplazos",
        "modificar_nota",
        "actualizar_contacto",
        "obtener_estadisticas",
        "obtener_nota",
      ].sort(),
    );
    const notes = await client.callTool({ name: "listar_notas", arguments: { limit: 1 } });
    assert.equal(notes.isError, undefined);
    const noteResult = notes.structuredContent as { notes: unknown[]; total: number; limit: number };
    assert.equal(Array.isArray(noteResult.notes), true);
    assert.equal(noteResult.total, 2);
    assert.equal(noteResult.limit, 1);
    assert.equal(noteResult.notes.length, 1);

    const drafts = await client.callTool({ name: "consultar_borradores", arguments: { query: "Primera", limit: 10 } });
    assert.equal(drafts.isError, undefined);
    const draftsResult = drafts.structuredContent as {
      notes: Array<Record<string, unknown>>;
      total: number;
      limit: number;
    };
    assert.equal(draftsResult.total, 1);
    assert.equal(draftsResult.notes[0]?.title, "Primera nota");

    const fullNote = await client.callTool({ name: "obtener_nota", arguments: { id: firstNote.id } });
    assert.equal(fullNote.isError, undefined);
    assert.equal((fullNote.structuredContent as { body: string }).body, "Contenido verificable");

    const directoryWithoutContacts = await client.callTool({
      name: "buscar_directorio",
      arguments: { query: "Banda de prueba", includeContacts: false },
    });
    const safeDirectory = (directoryWithoutContacts.structuredContent as { items: Array<Record<string, unknown>> })
      .items[0]!;
    assert.deepEqual(safeDirectory.contacts, []);
    assert.equal("emails" in safeDirectory, false);
    assert.equal("phones" in safeDirectory, false);

    const directoryWithContacts = await client.callTool({
      name: "buscar_directorio",
      arguments: { query: "Banda de prueba", includeContacts: true },
    });
    const detailedDirectory = (directoryWithContacts.structuredContent as { items: Array<Record<string, unknown>> })
      .items[0]!;
    assert.deepEqual(detailedDirectory.emails, ["banda@example.com"]);
    assert.equal((detailedDirectory.contacts as Array<Record<string, unknown>>)[0]?.email, "manager@example.com");

    const createdDirectoryItem = await client.callTool({
      name: "crear_contacto",
      arguments: {
        kind: "media",
        name: "Medio creado por MCP",
        city: "CABA",
        emails: ["medio@example.com"],
        contacts: [{ name: "Editora MCP", email: "editora@example.com" }],
      },
    });
    assert.equal(createdDirectoryItem.isError, undefined);
    const createdDirectoryResult = createdDirectoryItem.structuredContent as { id: string; createdBy: string };
    assert.equal(createdDirectoryResult.createdBy, "editor-1");
    const updatedDirectoryItem = await client.callTool({
      name: "actualizar_contacto",
      arguments: { id: createdDirectoryResult.id, description: "Medio actualizado desde MCP" },
    });
    assert.equal(updatedDirectoryItem.isError, undefined);
    assert.equal(
      (updatedDirectoryItem.structuredContent as { description: string }).description,
      "Medio actualizado desde MCP",
    );

    const draft = await client.callTool({
      name: "crear_nota",
      arguments: {
        title: "La banda de prueba presenta una canción nueva",
        summary: "Una novedad de la escena local.",
        body: "La banda de prueba presentó una canción nueva en CABA.",
        idempotencyKey: "contract-note-1",
      },
    });
    assert.equal(draft.isError, undefined);
    const draftResult = draft.structuredContent as { id: string; status: string; idempotencyKey?: string };
    assert.equal(draftResult.status, "draft");
    assert.equal("idempotencyKey" in draftResult, false);
    const modified = await client.callTool({
      name: "modificar_nota",
      arguments: {
        id: draftResult.id,
        title: "La banda de prueba presenta una canción nueva — actualización",
        summary: "La novedad de la escena local, actualizada.",
      },
    });
    assert.equal(modified.isError, undefined);
    const modifiedResult = modified.structuredContent as {
      id: string;
      status: string;
      title: string;
      updatedBy: string;
    };
    assert.equal(modifiedResult.id, draftResult.id);
    assert.equal(modifiedResult.status, "draft");
    assert.equal(modifiedResult.title, "La banda de prueba presenta una canción nueva — actualización");
    assert.equal(modifiedResult.updatedBy, "editor-1");
    const canonicalUpdate = await client.callTool({
      name: "actualizar_nota",
      arguments: { id: draftResult.id, body: "Contenido corregido por el editor." },
    });
    assert.equal(canonicalUpdate.isError, undefined);
    assert.equal((canonicalUpdate.structuredContent as { body: string }).body, "Contenido corregido por el editor.");
    const replay = await client.callTool({
      name: "crear_nota",
      arguments: {
        title: "La banda de prueba presenta una canción nueva",
        summary: "Una novedad de la escena local.",
        body: "La banda de prueba presentó una canción nueva en CABA.",
        idempotencyKey: "contract-note-1",
      },
    });
    assert.equal((replay.structuredContent as { id: string }).id, draftResult.id);

    currentAuth = authInfo(["press"]);
    const agenda = await client.callTool({
      name: "listar_agenda",
      arguments: { query: "festival", from: "2026-10-01T00:00:00.000Z", to: "2026-12-01T00:00:00.000Z" },
    });
    assert.equal(agenda.isError, undefined);
    const agendaResult = agenda.structuredContent as { events: unknown[]; total: number };
    assert.equal(agendaResult.total, 1);
    assert.equal(agendaResult.events.length, 1);

    const createdEvent = await client.callTool({
      name: "crear_evento",
      arguments: {
        name: "Fecha creada por MCP",
        artist: "Artista de prueba",
        city: "CABA",
        startsAt: "2026-12-05T20:00:00.000Z",
      },
    });
    assert.equal(createdEvent.isError, undefined);
    const createdEventResult = createdEvent.structuredContent as { id: string; createdBy: string };
    assert.equal(createdEventResult.createdBy, "editor-1");

    const contact = await press.createContact({ name: "Producción MCP", email: "produccion@example.com" });
    const accreditation = await client.callTool({
      name: "gestionar_acreditacion",
      arguments: {
        action: "crear",
        eventId: createdEventResult.id,
        contactId: contact.id,
        subject: "Acreditación MCP",
      },
    });
    assert.equal(accreditation.isError, undefined);
    const accreditationResult = accreditation.structuredContent as { id: string; managedBy: string };
    assert.equal(accreditationResult.managedBy, "editor-1");

    const updatedAccreditation = await client.callTool({
      name: "gestionar_acreditacion",
      arguments: { action: "actualizar", id: accreditationResult.id, status: "sent" },
    });
    assert.equal(updatedAccreditation.isError, undefined);

    const stats = await client.callTool({ name: "obtener_estadisticas", arguments: {} });
    assert.equal(stats.isError, undefined);
    const statistics = stats.structuredContent as {
      publications: { total: number };
      agenda: { events: number; accreditations: number };
    };
    assert.equal(statistics.publications.total, 0);
    assert.equal(statistics.agenda.events, 2);
    assert.equal(statistics.agenda.accreditations, 1);

    const replacements = await client.callTool({
      name: "listar_reemplazos",
      arguments: { profile: "photographer", includeApplications: true },
    });
    assert.equal(replacements.isError, undefined);
    const replacementResult = replacements.structuredContent as {
      searches: unknown[];
      applications: unknown[];
      total: number;
    };
    assert.equal(replacementResult.total, 1);
    assert.equal(replacementResult.searches.length, 1);
    assert.equal(replacementResult.applications.length, 1);

    const invalidDateRange = await client.callTool({
      name: "listar_agenda",
      arguments: { from: "2026-12-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" },
    });
    assert.equal(invalidDateRange.isError, true);

    currentAuth = authInfo(["editor"]);
    const stateChange = await client.callTool({
      name: "cambiar_estado_nota",
      arguments: { id: firstNote.id, status: "review" },
    });
    assert.equal(stateChange.isError, undefined);
    assert.equal((stateChange.structuredContent as { status: string }).status, "review");
    const forbiddenAgenda = await client.callTool({ name: "listar_agenda", arguments: {} });
    assert.equal(forbiddenAgenda.isError, true);
    const forbiddenReplacements = await client.callTool({ name: "listar_reemplazos", arguments: {} });
    assert.equal(forbiddenReplacements.isError, true);

    currentAuth = authInfo(["auditor"]);
    const forbiddenContacts = await client.callTool({
      name: "buscar_directorio",
      arguments: { includeContacts: true },
    });
    assert.equal(forbiddenContacts.isError, true);
  } finally {
    await client.close();
    await server.close();
  }
});
