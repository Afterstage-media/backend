import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ContentManager } from "./content-manager.js";
import { AiWriter } from "../infrastructure/integrations/ai.js";
import { MetaPublisher } from "../infrastructure/integrations/meta.js";
import { ContentStore } from "../infrastructure/persistence/content-store.js";
import { MediaAssetStore } from "../infrastructure/persistence/media-assets.js";
import { MemorySocialTemplateStore } from "../infrastructure/persistence/social-templates.js";

test("la simulación no altera el estado editorial", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "afterstage-"));
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
    channels: ["website"],
  });
  await manager.update(created.id, { status: "review" });
  await manager.update(created.id, { status: "approved" });

  const simulated = await manager.publish(created.id, true);
  assert.equal(simulated.status, "approved");
  assert.equal((await manager.required(created.id)).publishedAt, null);
});

test("bloquea publicación de fotos hasta validar derechos y contexto con revisión humana", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "afterstage-photo-rights-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const manager = new ContentManager(
    new ContentStore(directory),
    {} as AiWriter,
    {
      publish: async () => ({ instagram: "published-photo" }),
    } as unknown as MetaPublisher,
  );
  const photoRights = {
    sourceUrl: "https://commons.example/recital",
    creator: "Foto Real",
    license: "by",
    licenseVersion: "4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    termsUrl: "https://commons.example/terms",
    permissionType: "license_terms" as const,
    evidenceUrl: "https://commons.example/license-proof",
    evidenceCheckedAt: new Date().toISOString(),
    allowedUses: ["instagram", "commercial", "adaptation", "platform_sublicense"] as const,
    subjectContext: "Banda Aurora show en Niceto",
    contextType: "artist_or_subject" as const,
    documentaryPhotograph: true as const,
  };
  const item = await manager.create({
    title: "Banda Aurora en Niceto",
    summary: "La banda presentó su nuevo disco en vivo.",
    body: "La cobertura de Banda Aurora en Niceto.",
    instagramCopy: "Banda Aurora en Niceto.",
    channels: ["instagram"],
    assets: [{ id: "photo-1", url: "https://afterstage.test/photo.jpg", credit: "Foto: Foto Real", photoRights }],
  });
  await manager.update(item.id, { status: "review" });
  await manager.update(item.id, { status: "approved" });
  await assert.rejects(() => manager.publish(item.id), /cada foto debe tener licencia/);
  await assert.rejects(
    () =>
      manager.reviewInstagramPhoto(
        item.id,
        1,
        "editor-1",
        "approved",
        "La foto es de una artista distinta.",
        true,
        true,
      ),
    /no corresponde/,
  );
  const reviewed = await manager.reviewInstagramPhoto(
    item.id,
    1,
    "editor-1",
    "approved",
    "La foto muestra a Banda Aurora durante su presentación en Niceto.",
    true,
    true,
  );
  assert.equal(reviewed.assets[0]?.photoRights?.review.status, "approved");
  assert.equal(reviewed.assets[0]?.photoRights?.review.reviewedBy, "editor-1");
  assert.equal(reviewed.assets[0]?.photoRights?.evidenceUrl, "https://commons.example/license-proof");
  const published = await manager.publish(item.id);
  assert.equal(published.status, "published");
});

test("rechaza foto de archivo si el copy la presenta como un evento actual", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "afterstage-photo-archive-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const manager = new ContentManager(new ContentStore(directory));
  const item = await manager.create({
    title: "Banda Aurora en vivo hoy",
    instagramCopy: "Anoche en Niceto.",
    channels: ["instagram"],
    assets: [
      {
        id: "photo-archive",
        url: "https://afterstage.test/archive.jpg",
        credit: "Foto: Archivo Afterstage",
        photoRights: {
          sourceUrl: "https://afterstage.test/archive",
          creator: "Archivo Afterstage",
          license: "owned",
          licenseVersion: "internal-2026-11",
          licenseUrl: "https://afterstage.test/rights",
          termsUrl: "https://afterstage.test/terms",
          permissionType: "owned_work",
          evidenceUrl: "https://afterstage.test/evidence",
          evidenceCheckedAt: new Date().toISOString(),
          allowedUses: ["instagram", "commercial", "adaptation", "platform_sublicense"],
          subjectContext: "Banda Aurora archivo",
          contextType: "event_archive",
          documentaryPhotograph: true,
        },
      },
    ],
  });
  await assert.rejects(
    () =>
      manager.reviewInstagramPhoto(item.id, 1, "editor-1", "approved", "Foto de archivo de Banda Aurora.", true, true),
    /copy presenta el contenido como actual/,
  );
});

test("bloquea una publicación programada una sola vez y permite recuperarla tras revisar derechos", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "afterstage-photo-scheduled-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const manager = new ContentManager(
    new ContentStore(directory),
    {} as AiWriter,
    {
      publish: async () => ({ instagram: "photo-after-review" }),
    } as unknown as MetaPublisher,
  );
  const item = await manager.create({
    title: "Banda Aurora Niceto",
    summary: "La banda tocó en Niceto.",
    channels: ["instagram"],
    assets: [
      {
        id: "photo-scheduled",
        url: "https://afterstage.test/photo.jpg",
        credit: "Foto: Archivo Afterstage",
        photoRights: {
          sourceUrl: "https://afterstage.test/photo-source",
          creator: "Fotógrafa",
          license: "by",
          licenseVersion: "4.0",
          licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
          termsUrl: "https://afterstage.test/terms",
          permissionType: "license_terms",
          evidenceUrl: "https://afterstage.test/evidence",
          evidenceCheckedAt: new Date().toISOString(),
          allowedUses: ["instagram", "commercial", "adaptation", "platform_sublicense"],
          subjectContext: "Banda Aurora Niceto",
          contextType: "artist_or_subject",
          documentaryPhotograph: true,
        },
      },
    ],
  });
  await manager.update(item.id, { status: "review" });
  await manager.update(item.id, { status: "approved" });
  await manager.update(item.id, { status: "scheduled", scheduledAt: new Date(Date.now() - 1000).toISOString() });
  await manager.publishDue();
  const blocked = await manager.required(item.id);
  assert.equal(blocked.status, "failed");
  assert.equal(blocked.scheduledAt, null);
  assert.equal(blocked.nextAttemptAt, null);
  await manager.publishDue();
  assert.equal((await manager.required(item.id)).status, "failed");
  const reviewed = await manager.reviewInstagramPhoto(
    item.id,
    1,
    "editor-1",
    "approved",
    "Foto de archivo identificada de Banda Aurora en Niceto.",
    true,
    true,
  );
  assert.equal(reviewed.assets[0]?.photoRights?.review.status, "approved");
  assert.equal((await manager.publish(item.id)).status, "published");
});

test("crea y deduplica una placa de marca sin imágenes de entrada", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "afterstage-brand-graphic-"));
  const mediaDirectory = await mkdtemp(path.join(os.tmpdir(), "afterstage-brand-graphic-files-"));
  context.after(() =>
    Promise.all([
      rm(directory, { recursive: true, force: true }),
      rm(mediaDirectory, { recursive: true, force: true }),
    ]),
  );
  const templates = new MemorySocialTemplateStore();
  await templates.init();
  const template = await templates.findBySlug("agenda-mensual");
  assert.ok(template);
  const manager = new ContentManager(
    new ContentStore(directory),
    undefined,
    undefined,
    new MediaAssetStore(mediaDirectory, "https://afterstage.test"),
  );
  const brief = {
    title: "Shows confirmados esta semana",
    summary: "Fechas verificadas en las fuentes oficiales.",
    instagramCopy: "Consultá las fechas confirmadas.",
    source: "https://afterstage.test/agenda",
    notes: "Fechas contrastadas con las páginas oficiales de cada evento.",
    tags: ["Agenda"],
    idempotencyKey: "instagram-brand-graphic:test",
  };
  const slides = [
    { eyebrow: "AGENDA AFTERSTAGE", title: "Shows confirmados", body: "Esta semana" },
    { eyebrow: "EN VIVO", title: "Banda Aurora", body: "Niceto · viernes" },
  ];
  const created = await manager.prepareEditorialGraphic(template, brief, slides);
  assert.equal(created.visualSource, "brand_graphic");
  assert.equal(created.assets.length, 2);
  assert.equal(
    created.assets.some((asset) => asset.photoRights),
    false,
  );
  const replay = await manager.prepareEditorialGraphic(template, brief, slides);
  assert.equal(replay.id, created.id);
  await assert.rejects(
    () => manager.prepareEditorialGraphic(template, { ...brief, title: "Otro título" }, slides),
    /clave de idempotencia ya se usó/,
  );
});

test("reclama una publicación para evitar duplicados concurrentes", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "afterstage-claim-"));
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

test("bloquea el recompartido de Instagram cuando faltan derechos aprobados", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "afterstage-repost-instagram-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const calls: any[] = [];
  const publisher = {
    publish: async (item: any) => {
      calls.push(item);
      return { instagram: "reposted-media", containerId: "reposted-container" };
    },
  } as unknown as MetaPublisher;
  const manager = new ContentManager(new ContentStore(directory), {} as AiWriter, publisher);
  const created = await manager.create({
    title: "Una nota publicada",
    summary: "Una bajada",
    body: "El cuerpo completo",
    channels: ["website", "instagram"],
    assets: [{ id: "foto", url: "https://example.com/foto.jpg", altText: "", credit: "" }],
  });
  await manager.update(created.id, { status: "review" });
  await manager.update(created.id, { status: "approved" });
  await assert.rejects(() => manager.publish(created.id), /cada foto debe tener licencia/);

  const previousJwtSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "content-manager-repost-test-secret";
  const idempotency = { key: "repost-1", actorId: "admin-1" };
  await manager.store.update(created.id, { status: "published" });
  await assert.rejects(() => manager.repostInstagram(created.id, false, idempotency), /cada foto debe tener licencia/);
  assert.equal(calls.length, 0);
  if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousJwtSecret;
});

test("rechaza crear contenidos en estados internos y programar sin fecha", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "afterstage-validation-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const manager = new ContentManager(new ContentStore(directory));
  await assert.rejects(() => manager.create({ title: "Interno", status: "published" }), /comenzar como idea/);
  const item = await manager.create({ title: "Agenda" });
  await manager.update(item.id, { status: "review" });
  await manager.update(item.id, { status: "approved" });
  await assert.rejects(() => manager.update(item.id, { status: "scheduled" }), /fecha y hora/);
});

test("detecta duplicados exactos y notas muy similares, pero permite contenido distinto", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "afterstage-duplicates-"));
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
  const directory = await mkdtemp(path.join(os.tmpdir(), "afterstage-instagram-metrics-"));
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
  const directory = await mkdtemp(path.join(os.tmpdir(), "afterstage-ai-"));
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

test("guarda una nota redactada por el agente como borrador sin publicarla", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "afterstage-ai-note-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const manager = new ContentManager(new ContentStore(directory));

  const note = await manager.createAgentNote({
    title: "La banda vuelve a escena",
    summary: "Una nueva fecha para la escena independiente.",
    body: "La banda vuelve a escena con un show en el barrio.",
    tags: ["música"],
  });

  assert.equal(note.title, "La banda vuelve a escena");
  assert.equal(note.status, "draft");
  assert.equal(note.body, "La banda vuelve a escena con un show en el barrio.");
});

test("crea notas MCP con imágenes y permite adjuntar más imágenes a una nota", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "afterstage-ai-note-media-"));
  const mediaDirectory = await mkdtemp(path.join(os.tmpdir(), "afterstage-ai-note-media-files-"));
  context.after(() =>
    Promise.all([
      rm(directory, { recursive: true, force: true }),
      rm(mediaDirectory, { recursive: true, force: true }),
    ]),
  );
  const media = new MediaAssetStore(mediaDirectory, "https://afterstage.test");
  const manager = new ContentManager(new ContentStore(directory), undefined, undefined, media);
  const image = {
    base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    mimeType: "image/png" as const,
  };

  const note = await manager.createAgentNote({
    title: "Nota con imagen",
    body: "Contenido con un medio adjunto.",
    images: [image],
  });
  assert.equal(note.assets.length, 1);
  assert.match(note.assets[0]!.url, /^https:\/\/afterstage\.test\/media\//);

  const updated = await manager.addImages(note.id, [image]);
  assert.equal(updated.assets.length, 2);
  assert.notEqual(updated.assets[0]!.localPath, updated.assets[1]!.localPath);
});

test("busca contexto editorial por título, cuerpo, etiquetas y fuente", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "afterstage-search-"));
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
  const directory = await mkdtemp(path.join(os.tmpdir(), "afterstage-failure-"));
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
  const directory = await mkdtemp(path.join(os.tmpdir(), "afterstage-success-"));
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
    assets: [
      {
        id: "f",
        url: "https://example.com/f.jpg",
        altText: "",
        credit: "Foto: Prensa",
        photoRights: {
          sourceUrl: "https://example.com/source",
          creator: "Prensa",
          license: "by",
          licenseVersion: "4.0",
          licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
          termsUrl: "https://example.com/terms",
          permissionType: "license_terms",
          evidenceUrl: "https://example.com/evidence",
          evidenceCheckedAt: new Date().toISOString(),
          allowedUses: ["instagram", "commercial", "adaptation", "platform_sublicense"],
          subjectContext: "Publicable",
          contextType: "artist_or_subject",
          documentaryPhotograph: true,
        },
      },
    ],
  });
  await manager.reviewInstagramPhoto(
    item.id,
    1,
    "editor",
    "approved",
    "La foto muestra al artista de esta publicación.",
    true,
    true,
  );
  await manager.update(item.id, { status: "review" });
  await manager.update(item.id, { status: "approved" });
  const published = await manager.publish(item.id);
  assert.equal(savedContainer, "container-1");
  assert.equal(published.remoteIds.instagram, "media-1");
  assert.equal(published.remoteIds.website, published.slug);
  assert.equal(published.publishedMediaId, "media-1");
});

test("programa reintento para errores transitorios", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "afterstage-retry-"));
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
