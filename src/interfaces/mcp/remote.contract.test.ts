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
  scopes: ["notes:read", "notes:write", "agenda:read", "directory:read", "replacements:read"],
  extra: { userId: "editor-1", roles, permissions: [] },
});

test("expone contratos de salida como objetos y aplica filtros, límites y roles MCP", async (context) => {
  const directoryPath = await mkdtemp(path.join(os.tmpdir(), "medio-under-mcp-contract-"));
  context.after(() => rm(directoryPath, { recursive: true, force: true }));

  const manager = new ContentManager(new ContentStore(directoryPath));
  const press = new PressManager(new PressStore(directoryPath));
  const directory = new DirectoryManager(new DirectoryStore(directoryPath));

  await manager.create({ title: "Primera nota", body: "Contenido verificable" });
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
        "crear_nota_con_ia",
        "buscar_directorio",
        "get_profile",
        "listar_agenda",
        "listar_notas",
        "listar_reemplazos",
      ].sort(),
    );
    const notes = await client.callTool({ name: "listar_notas", arguments: { limit: 1 } });
    assert.equal(notes.isError, undefined);
    const noteResult = notes.structuredContent as { notes: unknown[]; total: number; limit: number };
    assert.equal(Array.isArray(noteResult.notes), true);
    assert.equal(noteResult.total, 2);
    assert.equal(noteResult.limit, 1);
    assert.equal(noteResult.notes.length, 1);

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

    const draft = await client.callTool({
      name: "crear_nota_con_ia",
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
    const replay = await client.callTool({
      name: "crear_nota_con_ia",
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
