import { z } from "zod";
import { locationFields } from "../location.js";

export const eventStatuses = ["planned", "covered", "cancelled"] as const;
export const contactTypes = ["promoter", "venue", "label", "agency", "press", "artist", "other"] as const;
export const accreditationStatuses = [
  "draft",
  "sent",
  "followup",
  "accepted",
  "rejected",
  "attended",
  "coverage_sent",
] as const;
export const replacementProfiles = ["photographer", "notero", "cronista", "videographer"] as const;
export const replacementStatuses = ["open", "screening", "assigned", "completed", "cancelled", "closed"] as const;
export const applicationStatuses = ["pending", "shortlisted", "accepted", "rejected", "withdrawn"] as const;

const optionalUrl = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), "La URL debe usar HTTP o HTTPS")
  .or(z.literal(""));
const optionalDate = z.string().datetime().nullable().default(null);

export const eventSchema = z.object({
  name: z.string().min(1).max(180),
  artist: z.string().max(180).default(""),
  venue: z.string().max(180).default(""),
  city: z.string().max(120).default(""),
  ...locationFields,
  startsAt: optionalDate,
  status: z.enum(eventStatuses).default("planned"),
  organizerContactId: z.string().uuid().nullable().default(null),
  url: optionalUrl.default(""),
  notes: z.string().max(4000).default(""),
});

export const contactSchema = z.object({
  name: z.string().min(1).max(180),
  organization: z.string().max(180).default(""),
  type: z.enum(contactTypes).default("press"),
  email: z.string().email().or(z.literal("")).default(""),
  phone: z.string().max(80).default(""),
  instagram: z.string().max(120).default(""),
  website: optionalUrl.default(""),
  notes: z.string().max(4000).default(""),
});

export const accreditationSchema = z.object({
  eventId: z.string().uuid(),
  contactId: z.string().uuid().nullable().default(null),
  subject: z.string().min(1).max(220),
  message: z.string().max(10000).default(""),
  status: z.enum(accreditationStatuses).default("draft"),
  sentAt: optionalDate,
  followUpAt: optionalDate,
  response: z.string().max(4000).default(""),
  deliverables: z.string().max(2000).default("Nota, fotos y publicación en redes"),
});

export const coverageSchema = z.object({
  eventId: z.string().uuid().nullable().default(null),
  contentId: z.string().uuid().nullable().default(null),
  title: z.string().min(1).max(220),
  url: optionalUrl.default(""),
  publishedAt: optionalDate,
  reach: z.number().int().nonnegative().default(0),
  notes: z.string().max(4000).default(""),
});

export const replacementSearchSchema = z.object({
  eventId: z.string().uuid().nullable().default(null),
  title: z.string().min(3).max(220),
  profile: z.enum(replacementProfiles),
  description: z.string().max(5000).default(""),
  startsAt: optionalDate,
  city: z.string().max(120).default(""),
  ...locationFields,
  requirements: z.string().max(4000).default(""),
  compensation: z.string().max(1000).default(""),
  contactEmail: z.string().email(),
  status: z.enum(replacementStatuses).default("open"),
  deadlineAt: optionalDate,
  assignedApplicationId: z.string().uuid().nullable().default(null),
});

export const replacementApplicationSchema = z.object({
  searchId: z.string().uuid(),
  applicantName: z.string().min(2).max(180),
  applicantEmail: z.string().email(),
  profile: z.enum(replacementProfiles),
  message: z.string().max(4000).default(""),
  portfolioUrl: optionalUrl.default(""),
  status: z.enum(applicationStatuses).default("pending"),
});

export const mediaKitSchema = z.object({
  name: z.string().max(180).default("Medio Under"),
  tagline: z.string().max(300).default("Periodismo musical para la escena que hace."),
  mission: z.string().max(4000).default(""),
  audience: z.string().max(2000).default(""),
  team: z.string().max(4000).default(""),
  services: z.string().max(2000).default(""),
  email: z.string().email().or(z.literal("")).default(""),
  website: optionalUrl.default(""),
  instagram: z.string().max(120).default(""),
});

export type EventInput = z.infer<typeof eventSchema>;
export type ContactInput = z.infer<typeof contactSchema>;
export type AccreditationInput = z.infer<typeof accreditationSchema>;
export type CoverageInput = z.infer<typeof coverageSchema>;
export type ReplacementSearchInput = z.infer<typeof replacementSearchSchema>;
export type ReplacementApplicationInput = z.infer<typeof replacementApplicationSchema>;
export type MediaKit = z.infer<typeof mediaKitSchema>;
export type EventItem = EventInput & {
  id: string;
  createdAt: string;
  updatedAt: string;
};
export type ContactItem = ContactInput & {
  id: string;
  createdAt: string;
  updatedAt: string;
};
export type Accreditation = AccreditationInput & {
  id: string;
  createdAt: string;
  updatedAt: string;
};
export type Coverage = CoverageInput & {
  id: string;
  createdAt: string;
  updatedAt: string;
};
export type ReplacementSearch = ReplacementSearchInput & { id: string; createdAt: string; updatedAt: string };
export type ReplacementApplication = ReplacementApplicationInput & { id: string; createdAt: string; updatedAt: string };
export type PressDatabase = {
  events: EventItem[];
  contacts: ContactItem[];
  accreditations: Accreditation[];
  coverages: Coverage[];
  replacementSearches: ReplacementSearch[];
  replacementApplications: ReplacementApplication[];
  mediaKit: MediaKit;
};

export const emptyMediaKit = (): MediaKit => mediaKitSchema.parse({});
