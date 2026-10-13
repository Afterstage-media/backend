import { z } from "zod";
import { locationFields } from "../location.js";

export const directoryKinds = [
  "band",
  "artist",
  "manager",
  "venue",
  "festival",
  "label",
  "agency",
  "media",
  "other",
] as const;
export const directoryStatuses = ["active", "archived"] as const;
export const directoryVerificationStatuses = ["unverified", "verified", "stale", "incorrect"] as const;
const optionalUrl = z.string().url().or(z.literal("")).default("");

export const socialLinksSchema = z.object({
  instagram: z.string().max(160).default(""),
  facebook: z.string().max(300).default(""),
  youtube: optionalUrl,
  tiktok: z.string().max(300).default(""),
  spotify: optionalUrl,
  x: z.string().max(300).default(""),
  other: z.array(optionalUrl).max(20).default([]),
});
export const socialLinksPatchSchema = z.object({
  instagram: z.string().max(160).optional(),
  facebook: z.string().max(300).optional(),
  youtube: optionalUrl.optional(),
  tiktok: z.string().max(300).optional(),
  spotify: optionalUrl.optional(),
  x: z.string().max(300).optional(),
  other: z.array(optionalUrl).max(20).optional(),
});
export const directoryContactSchema = z.object({
  name: z.string().min(1).max(180),
  role: z.string().max(120).default(""),
  email: z.string().email().or(z.literal("")).default(""),
  phone: z.string().max(80).default(""),
  socials: socialLinksSchema.prefault({}),
  notes: z.string().max(2000).default(""),
});
export const directoryInputSchema = z.object({
  kind: z.enum(directoryKinds).default("other"),
  name: z.string().min(1).max(180),
  aliases: z.array(z.string().max(120)).max(30).default([]),
  description: z.string().max(4000).default(""),
  city: z.string().max(120).default(""),
  ...locationFields,
  website: optionalUrl,
  socials: socialLinksSchema.prefault({}),
  phones: z.array(z.string().max(80)).max(20).default([]),
  emails: z.array(z.string().email()).max(20).default([]),
  contacts: z.array(directoryContactSchema).max(50).default([]),
  tags: z.array(z.string().max(80)).max(50).default([]),
  notes: z.string().max(4000).default(""),
  source: z.string().max(500).default(""),
  status: z.enum(directoryStatuses).default("active"),
  verificationStatus: z.enum(directoryVerificationStatuses).default("unverified"),
  reliabilityScore: z.number().int().min(0).max(100).default(0),
  lastVerifiedAt: z.string().datetime().nullable().default(null),
  verifiedBy: z.string().max(180).nullable().default(null),
  verificationNotes: z.string().max(2000).default(""),
});
export const directoryPatchSchema = directoryInputSchema.partial();
export type DirectoryInput = z.infer<typeof directoryInputSchema>;
export type DirectoryPatch = z.infer<typeof directoryPatchSchema>;
export type DirectoryItem = DirectoryInput & {
  id: string;
  createdAt: string;
  updatedAt: string;
};

export const directoryVerificationSchema = z.object({
  status: z.enum(directoryVerificationStatuses),
  reliabilityScore: z.number().int().min(0).max(100).optional(),
  notes: z.string().max(2000).default(""),
});
export type DirectoryVerification = z.infer<typeof directoryVerificationSchema>;
