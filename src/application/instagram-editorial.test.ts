import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareInstagramEditorial } from "./instagram-editorial.js";
import { scheduleDueRecurringStories } from "./recurring-story-publisher.js";
import { ContentManager } from "./content-manager.js";
import { PressManager } from "./press-manager.js";
import { MemorySocialSeriesStore } from "../infrastructure/persistence/social-series.js";
import { MemorySocialTemplateStore } from "../infrastructure/persistence/social-templates.js";

test("rota una sola historia institucional y avanza una semana", async () => {
  const seriesStore = new MemorySocialSeriesStore();
  await seriesStore.init();
  const templates = new MemorySocialTemplateStore();
  await templates.init();
  const series = (await seriesStore.findBySlug("secuencia-afterstage-diaria"))!;
  await seriesStore.save({ ...series, nextRunAt: "2026-11-23" }, series.id);
  const calls: string[] = [];
  const manager = {
    scheduleRecurringStory: async ({ template }: Parameters<ContentManager["scheduleRecurringStory"]>[0]) =>
      calls.push(template.slug),
  } as unknown as ContentManager;
  const first = new Date("2026-11-23T15:05:00Z");
  assert.equal(await scheduleDueRecurringStories(manager, seriesStore, templates, first), 1);
  assert.equal(await scheduleDueRecurringStories(manager, seriesStore, templates, first), 0);
  assert.equal((await seriesStore.get(series.id))?.nextRunAt, "2026-11-30");
  assert.equal(await scheduleDueRecurringStories(manager, seriesStore, templates, new Date("2026-11-30T15:05:00Z")), 1);
  assert.notEqual(calls[0], calls[1]);
});

test("la agenda omite eventos cancelados y exige dos fechas con fuente", async () => {
  const manager = {
    store: { findByIdempotencyKey: async () => undefined },
  } as unknown as ContentManager;
  const press = {
    snapshot: async () => ({
      events: [
        { name: "A", status: "cancelled" },
        { name: "B", status: "planned", venue: "Sala", city: "Buenos Aires", url: "" },
        {
          name: "C",
          status: "planned",
          venue: "Sala",
          city: "Buenos Aires",
          url: "https://example.org/event",
          startsAt: "2026-11-25T23:00:00Z",
          dates: [],
        },
      ],
    }),
  } as unknown as PressManager;
  const result = await prepareInstagramEditorial(
    manager,
    press,
    new MemorySocialTemplateStore(),
    new Date("2026-11-24T15:00:00Z"),
  );
  assert.deepEqual(result, { result: "insufficient_agenda" });
});

test("la búsqueda automática usa una sola foto claramente coincidente y nunca publica", async () => {
  const templates = new MemorySocialTemplateStore();
  await templates.init();
  const template = await templates.findBySlug("noticia-musical");
  const calls: unknown[] = [];
  const manager = {
    store: { findByIdempotencyKey: async () => undefined, list: async () => [article()] },
    searchPhotoCandidates: async () => [photo("Soda Stereo", ["Soda Stereo", "Buenos Aires"])],
    downloadOpenversePhoto: async () => ({ bytes: Buffer.from([1, 2, 3]), mimeType: "image/jpeg" }),
    createInstagramSocialPublication: async (...args: unknown[]) => {
      calls.push(args);
      return { id: "photo-draft" };
    },
    prepareEditorialGraphic: async () => {
      throw new Error("no debe usar fallback");
    },
  } as unknown as ContentManager;
  const result = await prepareInstagramEditorial(
    manager,
    {} as PressManager,
    templates,
    new Date("2026-11-26T15:00:00Z"),
  );
  assert.deepEqual(result, { result: "draft", id: "photo-draft", visual: "photo_pending_review" });
  const [input, , usedTemplate, key] = calls[0] as [any, string, any, string];
  assert.equal(usedTemplate.id, template?.id);
  assert.equal(key, "instagram-editorial:2026-11-26");
  assert.equal(input.slides.length, 1);
  assert.equal(input.slides[0].image.photoRights.documentaryPhotograph, false);
  assert.deepEqual(input.slides[0].image.photoRights.allowedUses, [
    "instagram",
    "commercial",
    "adaptation",
    "platform_sublicense",
  ]);
});

test("si Openverse no tiene una coincidencia clara conserva la placa tipográfica", async () => {
  const templates = new MemorySocialTemplateStore();
  await templates.init();
  let graphicCalls = 0;
  const manager = {
    store: { findByIdempotencyKey: async () => undefined, list: async () => [article()] },
    searchPhotoCandidates: async () => [photo("Festival", ["festival", "rock", "música"])],
    downloadOpenversePhoto: async () => {
      throw new Error("no debería descargarse");
    },
    prepareEditorialGraphic: async () => {
      graphicCalls += 1;
      return { id: "graphic-draft" };
    },
  } as unknown as ContentManager;
  const result = await prepareInstagramEditorial(
    manager,
    {} as PressManager,
    templates,
    new Date("2026-11-26T15:00:00Z"),
  );
  assert.deepEqual(result, { result: "draft", id: "graphic-draft" });
  assert.equal(graphicCalls, 1);
});

function article() {
  return {
    id: "article-1",
    type: "article",
    status: "published",
    channels: ["website"],
    publishedAt: "2026-11-20T12:00:00Z",
    slug: "soda-stereo",
    title: "Soda Stereo anuncia una fecha",
    summary: "La banda confirmó una fecha especial y compartió detalles del concierto para sus seguidores.",
    body: "Soda Stereo confirmó una fecha en Buenos Aires.",
    source: "https://press.example/soda",
    tags: ["Soda Stereo", "Novedades"],
    remoteIds: {},
    createdAt: "2026-11-20T12:00:00Z",
  } as any;
}

function photo(title: string, tags: string[]) {
  return {
    provider: "openverse" as const,
    id: title,
    title,
    imageUrl: "https://images.unsplash.com/photo",
    sourceUrl: "https://source.example/photo",
    creator: "Autora",
    creatorUrl: null,
    license: "by",
    licenseVersion: "4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    providerName: "Flickr",
    sourceName: "flickr",
    thumbnailUrl: null,
    width: 1200,
    height: 800,
    tags,
    rightsVerified: false as const,
  };
}
