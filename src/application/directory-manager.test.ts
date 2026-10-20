import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DirectoryManager } from "./directory-manager.js";
import { DirectoryStore } from "../infrastructure/persistence/directory-store.js";

test("crea, busca, actualiza y elimina entradas del directorio con contactos", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "afterstage-directory-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const manager = new DirectoryManager(new DirectoryStore(directory));
  const band = await manager.create({
    kind: "band",
    name: "Banda Under",
    city: "CABA",
    emails: ["hola@example.com"],
    contacts: [{ name: "Ana", role: "Manager", email: "ana@example.com" }],
  });
  assert.equal((await manager.list("manager")).length, 1);
  await assert.rejects(() => manager.create({ kind: "band", name: "Banda Under" }), /Ya existe/);
  const updated = await manager.update(band.id, {
    socials: { instagram: "@banda" },
  });
  assert.equal(updated?.socials.instagram, "@banda");
  assert.equal(await manager.remove(band.id), true);
});

test("verifica entradas y calcula fiabilidad según el estado", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "afterstage-directory-verification-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const manager = new DirectoryManager(new DirectoryStore(directory));
  const item = await manager.create({ kind: "venue", name: "Sala Verificable" });

  assert.equal(item.verificationStatus, "unverified");
  assert.equal(item.reliabilityScore, 0);
  const verified = await manager.verify(item.id, { status: "verified", reliabilityScore: 92 }, "editor-1");
  assert.equal(verified.verificationStatus, "verified");
  assert.equal(verified.reliabilityScore, 92);
  assert.equal(verified.verifiedBy, "editor-1");
  assert.ok(verified.lastVerifiedAt);

  const stale = await manager.verify(item.id, { status: "stale" }, "directory-1");
  assert.equal(stale.verificationStatus, "stale");
  assert.equal(stale.reliabilityScore, 50);
  assert.equal(stale.verificationNotes, "");
});

test("registra votos comunitarios sin alterar la verificación editorial", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "medio-under-directory-votes-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const manager = new DirectoryManager(new DirectoryStore(directory));
  const item = await manager.create({ kind: "media", name: "Medio Confiable" });

  const voted = await manager.vote(item.id, { vote: "reliable" });
  assert.equal(voted.reliableVotes, 1);
  assert.equal(voted.unreliableVotes, 0);
  assert.equal(voted.verificationStatus, "unverified");

  const flagged = await manager.vote(item.id, { vote: "needs_review" });
  assert.equal(flagged.reliableVotes, 1);
  assert.equal(flagged.unreliableVotes, 1);
  assert.equal(flagged.reliabilityScore, 0);
});
