import { z } from "zod";

const sourceSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(120),
  url: z.string().url().max(2000),
  topic: z.string().trim().min(1).max(80),
  format: z.enum(["rss", "html"]).optional(),
  enabled: z.boolean().default(true),
  itemPattern: z
    .string()
    .min(1)
    .max(500)
    .refine(
      (value) => !/\\[1-9]|\([^)]*[+*][^)]*\)[+*{]|\([^)]*\|[^)]*\)[+*{]/.test(value),
      "La regex contiene una estructura de alto riesgo",
    )
    .optional(),
  titlePattern: z.string().max(500).optional(),
  linkPattern: z.string().max(500).optional(),
  summaryPattern: z.string().max(500).optional(),
  maxItems: z.number().int().min(1).max(30).default(10),
});
const validateSourceFormat = (source: z.infer<typeof sourceSchema>, context: z.RefinementCtx) => {
  if ((source.format ?? (source.itemPattern ? "html" : "rss")) === "html" && !source.itemPattern)
    context.addIssue({
      code: "custom",
      path: ["itemPattern"],
      message: "Las páginas HTML requieren una regex de elementos",
    });
};
export const newsSourceSchema = sourceSchema.superRefine(validateSourceFormat);

export const sourceInputSchema = sourceSchema.omit({ id: true }).superRefine(validateSourceFormat);
export const aiAnalysisSchema = z.object({
  title: z.string().min(1).max(220),
  summary: z.string().min(1).max(1200),
  facts: z.array(z.string().max(500)).max(20),
  missingFacts: z.array(z.string().max(300)).max(20),
  suggestedAngle: z.string().max(500),
  sourceIds: z.array(z.string().uuid()).max(30),
});
export const aiWeeklyDigestSchema = z.object({
  stories: z
    .array(
      z.object({
        itemIndexes: z.array(z.number().int().min(0).max(59)).min(1).max(10),
        relevanceScore: z.number().int().min(1).max(100),
        reason: z.string().trim().min(1).max(500),
      }),
    )
    .max(10),
});
export const aiCopySchema = z.object({
  articleTitle: z.string().trim().min(1).max(180),
  articleSummary: z.string().trim().min(1).max(600),
  articleBody: z.string().trim().min(1).max(50_000),
  instagramPost: z.string().max(2200),
  stories: z.array(z.string().max(500)).max(10),
  hashtags: z.array(z.string().max(80)).max(20),
  imageRecommendation: z.object({
    kind: z.enum(["source_image", "editorial_illustration", "no_image"]),
    rationale: z.string().max(500),
    searchQuery: z.string().max(240),
    altText: z.string().max(300),
    sourceUrl: z.string().url().nullable(),
  }),
});

export type NewsSource = z.infer<typeof newsSourceSchema> & { id: string; createdAt: string; updatedAt: string };
export type ScrapedItem = {
  id: string;
  sourceId: string;
  sourceName: string;
  topic: string;
  title: string;
  url: string;
  summary: string;
  scrapedAt: string;
};
export type AiAnalysis = z.infer<typeof aiAnalysisSchema>;
export type AiWeeklyDigest = z.infer<typeof aiWeeklyDigestSchema>;
export type AiCopy = z.infer<typeof aiCopySchema>;
