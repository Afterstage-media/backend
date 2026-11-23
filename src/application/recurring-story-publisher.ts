import { nextSeriesDate } from "../infrastructure/persistence/social-series.js";
import type { ContentManager } from "./content-manager.js";
import type { SocialSeriesRepository } from "../domain/content/social-series.js";
import type { SocialTemplateRepository } from "../domain/content/social-template.js";

export const argentinaParts = (date: Date) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return {
    day: `${value("year")}-${value("month")}-${value("day")}`,
    time: `${value("hour")}:${value("minute")}`,
  };
};

/** Rotates the approved artwork and skips missed slots rather than flooding Instagram. */
export const scheduleDueRecurringStories = async (
  manager: ContentManager,
  seriesStore: SocialSeriesRepository,
  templateStore: SocialTemplateRepository,
  now = new Date(),
): Promise<number> => {
  const current = argentinaParts(now);
  let scheduled = 0;
  for (const series of await seriesStore.list()) {
    if (!series.active || !series.autoPublish || !series.nextRunAt || current.day < series.nextRunAt) continue;
    if (current.time < series.publishTime) continue;
    const week = Math.floor((Date.parse(current.day) - Date.UTC(1970, 0, 5)) / (7 * 86_400_000));
    const index = week % series.fixedStoryTemplates.length;
    const story = series.fixedStoryTemplates[index];
    if (!story) continue;
    const template = await templateStore.findBySlug(story.templateSlug);
    if (!template) throw new Error(`No está disponible la plantilla ${story.templateSlug}`);
    await manager.scheduleRecurringStory({
      seriesId: series.id,
      runDate: current.day,
      index,
      scheduledAt: new Date(`${current.day}T${series.publishTime}:00-03:00`).toISOString(),
      template,
      data: story.data,
    });
    scheduled += 1;
    await seriesStore.completeAutoScheduleRun(
      series.id,
      series.nextRunAt,
      nextSeriesDate(current.day, series.cadence.every, series.cadence.unit),
    );
  }
  return scheduled;
};
