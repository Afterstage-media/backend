import { z } from "zod";

export const editorialVoiceInputSchema = z.object({
  guide: z.string().trim().max(20_000),
  examples: z.array(z.string().trim().min(1).max(5_000)).max(8).default([]),
});

export type EditorialVoiceInput = z.infer<typeof editorialVoiceInputSchema>;

export type EditorialVoice = EditorialVoiceInput & {
  authorId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
};
