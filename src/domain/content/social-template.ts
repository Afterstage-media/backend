import { z } from "zod";

export const socialTemplateStatus = ["draft", "published", "archived"] as const;
export const socialEditorialSections = [
  "show-calendar",
  "show-announcement",
  "show-recap",
  "discovery",
  "curiosity",
  "news",
] as const;
export const socialOutputTypes = ["post", "carousel", "story"] as const;

export const socialTemplateSchema = z.object({
  id: z.string().optional(),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(80)
    .regex(/^[a-z0-9-]+$/),
  name: z.string().trim().min(2).max(100),
  description: z.string().max(400).default(""),
  editorialSection: z.enum(socialEditorialSections),
  outputType: z.enum(socialOutputTypes),
  channels: z.array(z.enum(["instagram", "facebook"])).default(["instagram"]),
  status: z.enum(socialTemplateStatus).default("draft"),
  schemaVersion: z.number().int().positive().default(1),
  templateVersion: z.number().int().positive().default(1),
  guidanceVersion: z.number().int().nonnegative().default(0),
  editorialGuidance: z
    .object({
      purpose: z.string().max(500).default(""),
      angle: z.string().max(500).default(""),
      verify: z.array(z.string().max(300)).max(12).default([]),
      slidePlan: z.array(z.string().max(300)).max(9).default([]),
      caption: z.string().max(800).default(""),
      voice: z.string().max(500).default(""),
      avoid: z.array(z.string().max(300)).max(12).default([]),
    })
    .default({ purpose: "", angle: "", verify: [], slidePlan: [], caption: "", voice: "", avoid: [] }),
  canvas: z.object({ width: z.number().int().min(640).max(2160), height: z.number().int().min(640).max(2160) }),
  fields: z
    .array(
      z.object({
        key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/),
        label: z.string().min(1).max(80),
        required: z.boolean().default(false),
        maxLength: z.number().int().min(1).max(500).default(160),
      }),
    )
    .min(1)
    .max(12),
  slides: z
    .array(
      z.object({
        eyebrow: z.string().max(80).default(""),
        titleField: z.string(),
        bodyField: z.string().optional(),
        accent: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .default("#7b35ff"),
        background: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .default("#111114"),
      }),
    )
    .min(1)
    .max(9),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  publishedAt: z.string().nullable().optional(),
});

export type SocialTemplate = z.infer<typeof socialTemplateSchema> & { id: string };
export type SocialTemplateInput = z.input<typeof socialTemplateSchema>;
export type SocialTemplateRepository = {
  init(): Promise<void>;
  list(filters?: { section?: string; type?: string; status?: string; channel?: string }): Promise<SocialTemplate[]>;
  get(id: string): Promise<SocialTemplate | undefined>;
  findBySlug(slug: string): Promise<SocialTemplate | undefined>;
  save(input: SocialTemplateInput, id?: string): Promise<SocialTemplate>;
};
