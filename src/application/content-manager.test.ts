import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ContentManager } from "./content-manager.js";
import { AiWriter } from "../infrastructure/integrations/ai.js";
import { MetaPublisher } from "../infrastructure/integrations/meta.js";
import { ContentStore } from "../infrastructure/persistence/content-store.js";

test("la simulación no altera el estado editorial", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "medio-under-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const manager = new ContentManager(
    new ContentStore(directory),
    {} as AiWriter,
    {
      publish: async () => ({ instagram: "dry-run" }),
    } as unknown as MetaPublisher,
  );
  const created = await manager.create({
    title: "Prueba de publicación",
    channels: ["instagram"],
    assets: [
      {
        id: "foto",
        url: "https://example.com/foto.jpg",
        altText: "",
        credit: "",
      },
    ],
  });
  await manager.update(created.id, { status: "review" });
  await manager.update(created.id, { status: "approved" });

  const simulated = await manager.publish(created.id, true);
  assert.equal(simulated.status, "approved");
  assert.equal((await manager.required(created.id)).publishedAt, null);
});

test("reclama una publicación para evitar duplicados concurrentes", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "medio-under-claim-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const publisher = {
    publish: async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { instagram: "published-1" };
    },
  } as unknown as MetaPublisher;
  const first = new ContentManager(new ContentStore(directory), {} as AiWriter, publisher);
  const second = new ContentManager(new ContentStore(directory), {} as AiWriter, publisher);
  const created = await first.create({
    title: "Publicación única",
    channels: ["website"],
  });
  await first.update(created.id, { status: "review" });
  await first.update(created.id, { status: "approved" });
  const results = await Promise.allSettled([first.publish(created.id), second.publish(created.id)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
});

test("rechaza crear contenidos en estados internos y programar sin fecha", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "medio-under-validation-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const manager = new ContentManager(new ContentStore(directory));
  await assert.rejects(() => manager.create({ title: "Interno", status: "published" }), /comenzar como idea/);
  const item = await manager.create({ title: "Agenda" });
  await manager.update(item.id, { status: "review" });
  await manager.update(item.id, { status: "approved" });
  await assert.rejects(() => manager.update(item.id, { status: "scheduled" }), /fecha y hora/);
});

test("detecta duplicados exactos y notas muy similares, pero permite contenido distinto", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "medio-under-duplicates-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const manager = new ContentManager(new ContentStore(directory));
  await manager.create({
    title: "Festival de invierno en Niceto",
    summary: "La escena independiente se reúne",
    body: "Crónica completa del festival y sus bandas.",
  });
  await assert.rejects(
    () => manager.create({ title: "Festival de invierno en Niceto", body: "Otra redacción" }),
    /duplicado detectado/,
  );
  const matches = await manager.findDuplicates({
    title: "Festival invierno Niceto",
    body: "La escena independiente se reúne. Crónica completa del festival y sus bandas.",
  });
  assert.ok(matches[0] && matches[0].score >= 0.45);
  const different = await manager.findDuplicates({
    title: "Entrevista a una banda",
    body: "Una conversación sobre música nueva y producción.",
  });
  assert.equal(different.length, 0);
});

test("actualiza y agrega métricas de Instagram por publicación", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "medio-under-instagram-metrics-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const publisher = {
    getInstagramMetrics: async () => ({
      likes: 12,
      comments: 3,
      saves: 4,
      shares: 2,
      reach: 100,
      impressions: 140,
      plays: 0,
      totalInteractions: 21,
      fetchedAt: new Date().toISOString(),
    }),
  } as unknown as MetaPublisher;
  const manager = new ContentManager(new ContentStore(directory), {} as AiWriter, publisher);
  const item = await manager.create({ title: "Métricas Instagram", channels: ["instagram"] });
  const stored = await manager.store.update(item.id, { remoteIds: { instagram: "media-1" } });
  assert.ok(stored);
  await manager.refreshInstagramMetrics(item.id, false);
  const summary = await manager.instagramMetrics();
  assert.equal(summary.posts, 1);
  assert.equal(summary.totals.reach, 100);
  assert.equal(summary.totals.totalInteractions, 21);
});

test("guarda resultado de IA sin permitir que cambie el estado", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "medio-under-ai-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const ai = {
    generate: async () => ({
      title: "Título mejorado",
      summary: "Bajada",
      body: "Cuerpo",
      instagramCopy: "Copy",
      tags: ["under"],
    }),
  } as unknown as AiWriter;
  const manager = new ContentManager(new ContentStore(directory), ai, {} as MetaPublisher);
  const item = await manager.create({ title: "Borrador" });
  const updated = await manager.generate(item.id, "improve");
  assert.equal(updated.title, "Título mejorado");
  assert.equal(updated.status, "draft");
});

test("busca contexto editorial por título, cuerpo, etiquetas y fuente", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "medio-under-search-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const manager = new ContentManager(new ContentStore(directory));
  await manager.create({
    title: "Festival Under",
    body: "Cobertura en Niceto",
    tags: ["festival", "indie"],
    source: "Prensa del festival",
  });
  await manager.create({
    title: "Otra nota",
    body: "Escena local",
    tags: ["rock"],
  });
  const result = await manager.search("festival indie");
  assert.equal(result.length, 1);
  assert.equal(result[0]?.source, "Prensa del festival");
});

test("marca fallo permanente y no reintenta errores de permisos", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "medio-under-failure-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const publisher = {
    publish: async () => {
      throw new Error("token inválido");
    },
  } as unknown as MetaPublisher;
  const manager = new ContentManager(new ContentStore(directory), {} as AiWriter, publisher);
  const item = await manager.create({
    title: "Falla",
    channels: ["instagram"],
  });
  await manager.update(item.id, { status: "review" });
  await manager.update(item.id, { status: "approved" });
  await assert.rejects(() => manager.publish(item.id), /token inválido/);
  const failed = await manager.required(item.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.nextAttemptAt, null);
});

test("publica canales y persiste ids remotos, slug web y container", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "medio-under-success-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  let savedContainer = "";
  const publisher = {
    publish: async (_item: unknown, _dry: boolean, callback?: (id: string) => Promise<void>) => {
      await callback?.("container-1");
      savedContainer = "container-1";
      return { instagram: "media-1" };
    },
  } as unknown as MetaPublisher;
  const manager = new ContentManager(new ContentStore(directory), {} as AiWriter, publisher);
  const item = await manager.create({
    title: "Publicable",
    channels: ["website", "instagram"],
    assets: [{ id: "f", url: "https://example.com/f.jpg", altText: "", credit: "" }],
  });
  await manager.update(item.id, { status: "review" });
  await manager.update(item.id, { status: "approved" });
  const published = await manager.publish(item.id);
  assert.equal(savedContainer, "container-1");
  assert.equal(published.remoteIds.instagram, "media-1");
  assert.equal(published.remoteIds.website, published.slug);
  assert.equal(published.publishedMediaId, "media-1");
});

test("programa reintento para errores transitorios", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "medio-under-retry-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const publisher = {
    publish: async () => {
      throw new Error("servicio temporalmente no disponible");
    },
  } as unknown as MetaPublisher;
  const manager = new ContentManager(new ContentStore(directory), {} as AiWriter, publisher);
  const item = await manager.create({
    title: "Reintento",
    channels: ["instagram"],
  });
  await manager.update(item.id, { status: "review" });
  await manager.update(item.id, { status: "approved" });
  await assert.rejects(() => manager.publish(item.id), /temporalmente/);
  const retried = await manager.required(item.id);
  assert.equal(retried.status, "scheduled");
  assert.equal(retried.attempts, 1);
  assert.ok(retried.nextAttemptAt);
});
