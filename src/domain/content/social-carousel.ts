import { z } from "zod";

const imageInput = z.object({
  base64: z.string().trim().min(1).max(3_500_000),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]).optional(),
  filename: z.string().trim().max(255).optional(),
  altText: z.string().trim().min(1).max(500),
  credit: z.string().max(500).default(""),
});
const correctedImageInput = imageInput.extend({ altText: z.string().max(500).optional() });

export const instagramCarouselInputSchema = z.object({
  seriesId: z.string().trim().min(2).max(120).optional(),
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
  source: z.string().trim().min(1).max(500),
  author: z.string().trim().max(180).default(""),
  photographer: z.string().trim().max(180).default(""),
});

export const correctedCarouselImageSchema = z.object({ image: correctedImageInput });

export const instagramCarouselUpdateSchema = instagramCarouselInputSchema.extend({
  slides: z
    .array(
      z.object({
        image: imageInput.optional(),
        sourceAssetId: z.string().trim().min(1).max(180).optional(),
        text: z.string().trim().min(1).max(180),
      }),
    )
    .min(2)
    .max(9),
});

const instagramSocialPublicationBaseSchema = z.object({
  seriesId: z.string().trim().min(2).max(120).optional(),
  templateId: z.string().trim().min(1).max(120),
  type: z.enum(["post", "story"]),
  title: z.string().trim().min(1).max(180),
  instagramCopy: z.string().trim().min(1).max(2200),
  slides: z
    .array(
      z.object({
        image: imageInput,
        text: z.string().trim().min(1).max(180),
      }),
    )
    .min(1)
    .max(9),
  tags: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  source: z.string().trim().min(1).max(500),
  author: z.string().trim().max(180).default(""),
  photographer: z.string().trim().max(180).default(""),
});
const validateSocialStorySlideCount = (
  input: { type: "post" | "story"; slides: unknown[] },
  context: z.RefinementCtx,
) => {
  if (input.type === "story" && input.slides.length !== 1) {
    context.addIssue({ code: "custom", path: ["slides"], message: "Una historia de Instagram debe tener una lámina" });
  }
};
const socialPublicationSlideUpdateSchema = z.object({
  image: imageInput.optional(),
  sourceAssetId: z.string().trim().min(1).max(180).optional(),
  text: z.string().trim().min(1).max(180),
});
export const instagramSocialPublicationInputSchema =
  instagramSocialPublicationBaseSchema.superRefine(validateSocialStorySlideCount);
export const instagramSocialPublicationInputShape = instagramSocialPublicationBaseSchema.shape;
export const instagramSocialPublicationUpdateSchema = instagramSocialPublicationBaseSchema
  .extend({
    slides: z.array(socialPublicationSlideUpdateSchema).min(1).max(9),
  })
  .superRefine(validateSocialStorySlideCount);

export type InstagramCarouselInput = z.infer<typeof instagramCarouselInputSchema>;
export type InstagramCarouselUpdate = z.infer<typeof instagramCarouselUpdateSchema>;
export type InstagramSocialPublicationInput = z.infer<typeof instagramSocialPublicationInputSchema>;
export type InstagramSocialPublicationUpdate = z.infer<typeof instagramSocialPublicationUpdateSchema>;
export type CarouselSlideInput = InstagramCarouselInput["slides"][number];
export type CarouselImageInput = z.infer<typeof imageInput>;
