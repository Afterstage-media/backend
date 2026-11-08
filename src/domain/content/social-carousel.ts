import { z } from "zod";

const imageInput = z.object({
  base64: z.string().trim().min(1).max(3_500_000),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]).optional(),
  filename: z.string().trim().max(255).optional(),
  altText: z.string().max(500).default(""),
  credit: z.string().max(500).default(""),
});

export const instagramCarouselInputSchema = z.object({
  templateId: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(180),
  instagramCopy: z.string().trim().min(1).max(2200),
  slides: z
    .array(
      z.object({
        image: imageInput,
        text: z.string().trim().min(1).max(180),
      }),
    )
    .min(2)
    .max(9),
  tags: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  source: z.string().trim().max(500).default(""),
  author: z.string().trim().max(180).default(""),
  photographer: z.string().trim().max(180).default(""),
});

export const correctedCarouselImageSchema = z.object({ image: imageInput });

export type InstagramCarouselInput = z.infer<typeof instagramCarouselInputSchema>;
export type CarouselSlideInput = InstagramCarouselInput["slides"][number];
export type CarouselImageInput = z.infer<typeof imageInput>;
