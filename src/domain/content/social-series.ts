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
});

export type SocialSeries = z.infer<typeof socialSeriesSchema> & { id: string };
export type SocialSeriesInput = z.input<typeof socialSeriesSchema>;

export interface SocialSeriesRepository {
  init(): Promise<void>;
  list(): Promise<SocialSeries[]>;
  get(id: string): Promise<SocialSeries | undefined>;
  findBySlug(slug: string): Promise<SocialSeries | undefined>;
  save(input: SocialSeriesInput, id?: string): Promise<SocialSeries>;
  completeDraftRun(id: string, draftId: string): Promise<SocialSeries>;
}
