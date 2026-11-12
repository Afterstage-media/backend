import type { ContentManager } from "./content-manager.js";
import type { SocialSeriesRepository } from "../domain/content/social-series.js";
import type { SocialTemplateRepository } from "../domain/content/social-template.js";

const argentinaParts = (date: Date) => {
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

const nextDate = (date: string) => {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + 1, 12)).toISOString().slice(0, 10);
};

/** Creates one idempotent scheduled Story per fixed image once its daily local time is due. */
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
    if (current.day === series.nextRunAt && current.time < series.publishTime) continue;
    const runDate = current.day;
    for (const [index, story] of series.fixedStoryTemplates.entries()) {
      const scheduledAt = new Date(`${runDate}T${series.publishTime}:00-03:00`);
      scheduledAt.setUTCMinutes(scheduledAt.getUTCMinutes() + index);
      const template = await templateStore.findBySlug(story.templateSlug);
      if (!template) throw new Error(`No está disponible la plantilla ${story.templateSlug}`);
      await manager.scheduleRecurringStory({
        seriesId: series.id,
        runDate,
        index,
        scheduledAt: scheduledAt.toISOString(),
        template,
        data: story.data,
      });
      scheduled += 1;
    }
    await seriesStore.completeAutoScheduleRun(series.id, series.nextRunAt, nextDate(runDate));
  }
  return scheduled;
};
