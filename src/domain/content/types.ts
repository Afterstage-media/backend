import { z } from "zod";

export const contentStatuses = [
  "idea",
  "draft",
  "review",
  "approved",
  "scheduled",
  "publishing",
  "published",
  "failed",
] as const;

export const contentTypes = ["article", "post", "carousel", "reel", "story"] as const;
export const channels = ["website", "instagram", "facebook"] as const;

export const assetSchema = z.object({
  id: z.string(),
  url: z
    .string()
    .url()
    .refine((value) => /^https?:\/\//i.test(value), "La URL debe usar HTTP o HTTPS")
    .default(""),
  localPath: z.string().max(1000).default(""),
  mediaType: z.enum(["image", "video"]).default("image"),
  altText: z.string().default(""),
  credit: z.string().default(""),
});

export const contentInputSchema = z.object({
  type: z.enum(contentTypes).default("article"),
  title: z.string().min(1).max(180),
  slug: z.string().max(220).optional(),
  summary: z.string().max(600).default(""),
  body: z.string().default(""),
  status: z.enum(contentStatuses).default("draft"),
  channels: z.array(z.enum(channels)).default(["website", "instagram"]),
  assets: z.array(assetSchema).default([]),
  instagramCopy: z.string().max(2200).default(""),
  facebookCopy: z.string().default(""),
  tags: z.array(z.string().max(80)).default([]),
  scheduledAt: z.string().datetime().nullable().default(null),
  notes: z.string().default(""),
  author: z.string().max(180).default(""),
  photographer: z.string().max(180).default(""),
  source: z.string().max(500).default(""),
  seoTitle: z.string().max(180).default(""),
  seoDescription: z.string().max(320).default(""),
  canonicalUrl: z.string().url().or(z.literal("")).default(""),
  featured: z.boolean().default(false),
});

export const contentPatchSchema = contentInputSchema.partial();

export type ContentInput = z.infer<typeof contentInputSchema>;
export type ContentPatch = z.infer<typeof contentPatchSchema>;
export type ContentStatus = (typeof contentStatuses)[number];
export type Channel = (typeof channels)[number];

export type ContentItem = ContentInput & {
  id: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  remoteIds: Partial<Record<Channel, string>>;
  lastError: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  containerId: string | null;
  publishedMediaId: string | null;
  viewCount?: number;
  instagramMetrics?: InstagramMetrics | null;
};

export type InstagramMetrics = {
  likes: number;
  comments: number;
  saves: number;
  shares: number;
  reach: number;
  impressions: number;
  plays: number;
  totalInteractions: number;
  fetchedAt: string;
};

export type Database = { contents: ContentItem[] };

export const slugify = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
