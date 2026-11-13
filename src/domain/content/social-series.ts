import { z } from "zod";

export const socialSeriesInputSchema = z.object({
  id: z.string().trim().min(2).max(120).optional(),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(80)
    .regex(/^[a-z0-9-]+$/),
  name: z.string().trim().min(2).max(120),
  description: z.string().max(400).default(""),
  templateSlug: z
    .string()
    .trim()
    .min(2)
    .max(80)
    .regex(/^[a-z0-9-]+$/),
  editorialBrief: z.string().trim().min(1).max(1200),
  cadence: z.object({
    every: z.number().int().min(1).max(365),
    unit: z.enum(["day", "week", "month"]),
  }),
  nextRunAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .default(null),
  active: z.boolean().default(false),
  autoPublish: z.boolean().default(false),
  publishTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .default("12:00"),
  fixedStoryTemplates: z
    .array(
      z.object({
        templateSlug: z.string().trim().min(2).max(80),
        data: z.record(z.string(), z.string().max(500)),
      }),
    )
    .max(3)
    .default([]),
  lastAutoScheduledAt: z.string().nullable().default(null),
  lastDraftAt: z.string().nullable().default(null),
  lastDraftId: z.string().nullable().default(null),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export const socialSeriesInputShape = socialSeriesInputSchema.shape;
export const socialSeriesSchema = socialSeriesInputSchema.superRefine((series, context) => {
  if (series.active && !series.nextRunAt) {
    context.addIssue({ code: "custom", path: ["nextRunAt"], message: "Una serie activa necesita su próxima fecha" });
  }
  if (series.autoPublish && (series.cadence.every !== 1 || series.cadence.unit !== "day")) {
    context.addIssue({
      code: "custom",
      path: ["cadence"],
      message: "La publicación automática requiere frecuencia diaria",
    });
  }
  if (series.autoPublish && series.fixedStoryTemplates.length !== 3) {
    context.addIssue({
      code: "custom",
      path: ["fixedStoryTemplates"],
      message: "La secuencia automática necesita tres plantillas editables",
    });
  }
  if (series.autoPublish && new Set(series.fixedStoryTemplates.map((item) => item.templateSlug)).size !== 3) {
    context.addIssue({
      code: "custom",
      path: ["fixedStoryTemplates"],
      message: "Cada historia debe usar una plantilla distinta",
    });
  }
});

export type SocialSeries = z.infer<typeof socialSeriesSchema> & { id: string };
export type SocialSeriesInput = z.input<typeof socialSeriesSchema>;

export const socialSeriesCreationIdentity = (input: SocialSeriesInput) => {
  const series = socialSeriesSchema.parse(input);
  return JSON.stringify({
    slug: series.slug,
    name: series.name,
    description: series.description,
    templateSlug: series.templateSlug,
    editorialBrief: series.editorialBrief,
    cadence: series.cadence,
    nextRunAt: series.nextRunAt,
    active: series.active,
    autoPublish: series.autoPublish,
    publishTime: series.publishTime,
    fixedStoryTemplates: series.fixedStoryTemplates,
  });
};

export class SocialSeriesConflictError extends Error {
  constructor() {
    super("Ya existe una serie con ese nombre o identificador. Editá la serie existente o elegí otro nombre.");
    this.name = "SocialSeriesConflictError";
  }
}

export interface SocialSeriesRepository {
  init(): Promise<void>;
  list(): Promise<SocialSeries[]>;
  get(id: string): Promise<SocialSeries | undefined>;
  findBySlug(slug: string): Promise<SocialSeries | undefined>;
  create(input: SocialSeriesInput): Promise<SocialSeries>;
  save(input: SocialSeriesInput, id: string): Promise<SocialSeries>;
  completeDraftRun(id: string, draftId: string): Promise<SocialSeries>;
  completeAutoScheduleRun(id: string, runDate: string, nextRunAt: string): Promise<SocialSeries | undefined>;
}
