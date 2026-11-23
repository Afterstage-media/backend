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
