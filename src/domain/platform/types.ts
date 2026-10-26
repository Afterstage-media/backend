import { z } from "zod";

const optionalUrl = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), "La URL debe usar HTTP o HTTPS")
  .or(z.literal(""));
const optionalDate = z.string().datetime().nullable().default(null);

export const photographerStatuses = ["pending", "published", "archived"] as const;
export const coverageRequestStatuses = ["open", "screening", "assigned", "closed", "cancelled"] as const;
export const coverageApplicationStatuses = ["pending", "shortlisted", "accepted", "rejected", "withdrawn"] as const;
export const transportKinds = ["bus", "carpool", "shuttle", "other"] as const;
export const transportStatuses = ["open", "full", "closed", "cancelled"] as const;
export const insuranceStatuses = ["new", "contacted", "quoted", "closed"] as const;
export const insuranceNotificationStatuses = ["pending", "sent", "not_configured", "failed"] as const;
export const insuranceContractStatuses = ["pending", "contracted", "cancelled"] as const;
export const insuranceProducts = ["ap", "art", "vida", "robo_equipos"] as const;
export const insuranceProductLabels: Record<(typeof insuranceProducts)[number], string> = {
  ap: "Accidentes personales",
  art: "ART",
  vida: "Seguro de vida",
  robo_equipos: "Robo de equipos",
};
export const insuranceProductSchema = z.enum(insuranceProducts);
export const marketplaceCategories = ["merch", "service", "benefit"] as const;

export const photographerProfileSchema = z.object({
  name: z.string().trim().min(2).max(180),
  handle: z.string().trim().max(120).default(""),
  bio: z.string().max(2400).default(""),
  city: z.string().trim().min(2).max(120),
  specialties: z.array(z.string().trim().min(1).max(60)).max(12).default([]),
  portfolioUrl: optionalUrl.default(""),
  portfolioUrls: z.array(optionalUrl).max(10).default([]),
  instagram: z.string().trim().max(120).default(""),
  website: optionalUrl.default(""),
  sampleCount: z.number().int().min(0).max(100).default(0),
  availability: z.string().max(500).default(""),
  contactEmail: z.string().email().max(180),
  status: z.enum(photographerStatuses).default("pending"),
});

export const coverageRequestSchema = z.object({
  eventId: z.string().uuid().nullable().default(null),
  title: z.string().trim().min(3).max(220),
  description: z.string().trim().min(10).max(5000),
  requesterName: z.string().trim().min(2).max(180),
  requesterEmail: z.string().email().max(180),
  organization: z.string().max(180).default(""),
  city: z.string().max(120).default(""),
  budget: z.string().max(1000).default(""),
  deadlineAt: optionalDate,
  status: z.enum(coverageRequestStatuses).default("open"),
});

export const coverageApplicationSchema = z.object({
  requestId: z.string().uuid(),
  photographerId: z.string().uuid().nullable().default(null),
  applicantName: z.string().trim().min(2).max(180),
  applicantEmail: z.string().email().max(180),
  portfolioUrl: optionalUrl.default(""),
  message: z.string().max(4000).default(""),
  deliveryUrl: optionalUrl.default(""),
  deliveryNotes: z.string().max(4000).default(""),
  status: z.enum(coverageApplicationStatuses).default("pending"),
});

export const transportOfferSchema = z.object({
  eventId: z.string().uuid(),
  title: z.string().trim().min(3).max(220),
  kind: z.enum(transportKinds).default("other"),
  providerName: z.string().trim().min(2).max(180),
  origin: z.string().trim().min(2).max(180),
  destination: z.string().trim().min(2).max(180),
  departureAt: optionalDate,
  returnAt: optionalDate,
  seats: z.number().int().min(1).max(1000).default(1),
  priceLabel: z.string().max(500).default("Consultar"),
  contactUrl: optionalUrl.default(""),
  status: z.enum(transportStatuses).default("open"),
});

export const transportRequestSchema = z.object({
  eventId: z.string().uuid(),
  offerId: z.string().uuid().nullable().default(null),
  name: z.string().trim().min(2).max(180),
  email: z.string().email().max(180),
  partySize: z.number().int().min(1).max(20).default(1),
  origin: z.string().trim().min(2).max(180),
  notes: z.string().max(1200).default(""),
  status: z.enum(["new", "contacted", "confirmed", "cancelled"] as const).default("new"),
});

const insuranceProductDetailsBaseSchema = z.object({
  eventName: z.string().max(220).default(""),
  eventLocation: z.string().max(220).default(""),
  eventDescription: z.string().max(2000).default(""),
  apPeopleCount: z.number().int().min(1).max(100000).nullable().default(null),
  apInsuredSumLabel: z.string().max(180).default(""),
  artEmployer: z.string().max(180).default(""),
  artActivity: z.string().max(500).default(""),
  artWorkerCount: z.number().int().min(1).max(100000).nullable().default(null),
  vidaInsuredName: z.string().max(180).default(""),
  vidaInsuredAge: z.number().int().min(0).max(130).nullable().default(null),
  vidaInsuredSumLabel: z.string().max(180).default(""),
  vidaBeneficiary: z.string().max(500).default(""),
  equipmentDescription: z.string().max(2000).default(""),
  equipmentValueLabel: z.string().max(180).default(""),
  equipmentCount: z.number().int().min(1).max(100000).nullable().default(null),
  equipmentSerials: z.string().max(2000).default(""),
});

export const insuranceProductDetailsSchema = insuranceProductDetailsBaseSchema;
const defaultInsuranceProductDetails = insuranceProductDetailsBaseSchema.parse({});
export const insuranceRequestSchema = z
  .object({
    eventId: z.string().uuid().nullable().default(null),
    name: z.string().trim().min(2).max(180),
    dni: z.string().trim().max(30).default(""),
    organization: z.string().max(180).default(""),
    email: z.string().email().max(180),
    phone: z.string().max(80).default(""),
    coverageType: z.string().trim().max(500).default(""),
    coverageTypes: z.array(insuranceProductSchema).max(4).default([]),
    productDetails: insuranceProductDetailsBaseSchema.default(defaultInsuranceProductDetails),
    startsAt: optionalDate,
    endsAt: optionalDate,
    peopleCount: z.number().int().min(1).max(100000).default(1),
    notes: z.string().max(4000).default(""),
    providerName: z.string().max(180).default(""),
    quoteLabel: z.string().max(500).default(""),
    quoteUrl: optionalUrl.default(""),
    policyNumber: z.string().max(180).default(""),
    policyUrl: optionalUrl.default(""),
    internalNotes: z.string().max(4000).default(""),
    mailThreadId: z.string().max(180).default(""),
    notificationStatus: z.enum(insuranceNotificationStatuses).default("pending"),
    notificationTo: z.string().max(1000).default(""),
    contractStatus: z.enum(insuranceContractStatuses).default("pending"),
    contractedAt: optionalDate,
    commissionLabel: z.string().max(500).default(""),
    commissionNotes: z.string().max(4000).default(""),
    renewedFromId: z.string().max(180).default(""),
    status: z.enum(insuranceStatuses).default("new"),
  })
  .superRefine((value, context) => {
    const details = value.productDetails;
    const required = (condition: boolean, path: string[], message: string) => {
      if (!condition) context.addIssue({ code: "custom", path, message });
    };
    if (value.coverageTypes.includes("ap")) {
      required(
        Boolean(details.apPeopleCount),
        ["productDetails", "apPeopleCount"],
        "Indicá cuántas personas se aseguran.",
      );
      required(
        Boolean(details.apInsuredSumLabel.trim()),
        ["productDetails", "apInsuredSumLabel"],
        "Indicá la suma asegurada de AP.",
      );
    }
    if (value.coverageTypes.includes("art")) {
      required(
        Boolean(details.artEmployer.trim()),
        ["productDetails", "artEmployer"],
        "Indicá el empleador o razón social para ART.",
      );
      required(Boolean(details.artActivity.trim()), ["productDetails", "artActivity"], "Indicá la actividad para ART.");
      required(
        Boolean(details.artWorkerCount),
        ["productDetails", "artWorkerCount"],
        "Indicá la cantidad de trabajadores para ART.",
      );
    }
    if (value.coverageTypes.includes("vida")) {
      required(
        Boolean(details.vidaInsuredName.trim()),
        ["productDetails", "vidaInsuredName"],
        "Indicá la persona asegurada.",
      );
      required(
        Boolean(details.vidaInsuredSumLabel.trim()),
        ["productDetails", "vidaInsuredSumLabel"],
        "Indicá la suma asegurada de vida.",
      );
    }
    if (value.coverageTypes.includes("robo_equipos")) {
      required(
        Boolean(details.equipmentDescription.trim()),
        ["productDetails", "equipmentDescription"],
        "Describí los equipos a asegurar.",
      );
      required(
        Boolean(details.equipmentValueLabel.trim()),
        ["productDetails", "equipmentValueLabel"],
        "Indicá el valor total de los equipos.",
      );
      required(
        Boolean(details.equipmentCount),
        ["productDetails", "equipmentCount"],
        "Indicá cuántos equipos se aseguran.",
      );
    }
  });

export const forumThreadSchema = z.object({
  eventId: z.string().uuid(),
  title: z.string().trim().min(3).max(220),
  body: z.string().trim().min(10).max(5000),
  authorName: z.string().trim().min(2).max(180),
  authorEmail: z.string().email().max(180),
  status: z.enum(["visible", "hidden"] as const).default("visible"),
});

export const forumPostSchema = z.object({
  threadId: z.string().uuid(),
  body: z.string().trim().min(2).max(4000),
  authorName: z.string().trim().min(2).max(180),
  authorEmail: z.string().email().max(180),
  status: z.enum(["visible", "hidden"] as const).default("visible"),
});

export const marketplaceListingSchema = z.object({
  externalId: z.string().trim().max(180).default(""),
  name: z.string().trim().min(2).max(220),
  category: z.enum(marketplaceCategories),
  description: z.string().max(2400).default(""),
  imageUrl: optionalUrl.default(""),
  productUrl: optionalUrl.default(""),
  priceLabel: z.string().max(120).default("Consultar"),
  source: z.enum(["orux", "afterstage"] as const).default("orux"),
  active: z.boolean().default(true),
});

export type PhotographerProfileInput = z.infer<typeof photographerProfileSchema>;
export type CoverageRequestInput = z.infer<typeof coverageRequestSchema>;
export type CoverageApplicationInput = z.infer<typeof coverageApplicationSchema>;
export type TransportOfferInput = z.infer<typeof transportOfferSchema>;
export type TransportRequestInput = z.infer<typeof transportRequestSchema>;
export type InsuranceRequestInput = z.infer<typeof insuranceRequestSchema>;
export type InsuranceProduct = (typeof insuranceProducts)[number];
export type InsuranceProductDetails = z.infer<typeof insuranceProductDetailsSchema>;
export type ForumThreadInput = z.infer<typeof forumThreadSchema>;
export type ForumPostInput = z.infer<typeof forumPostSchema>;
export type MarketplaceListingInput = z.infer<typeof marketplaceListingSchema>;

export type PlatformItem<T> = T & { id: string; createdAt: string; updatedAt: string };
export type PhotographerProfile = PlatformItem<PhotographerProfileInput>;
export type CoverageRequest = PlatformItem<CoverageRequestInput>;
export type CoverageApplication = PlatformItem<CoverageApplicationInput>;
export type TransportOffer = PlatformItem<TransportOfferInput>;
export type TransportRequest = PlatformItem<TransportRequestInput>;
export type InsuranceRequest = PlatformItem<InsuranceRequestInput>;
export type ForumThread = PlatformItem<ForumThreadInput>;
export type ForumPost = PlatformItem<ForumPostInput>;
export type MarketplaceListing = PlatformItem<MarketplaceListingInput>;

export type PlatformDatabase = {
  photographers: PhotographerProfile[];
  coverageRequests: CoverageRequest[];
  coverageApplications: CoverageApplication[];
  transportOffers: TransportOffer[];
  transportRequests: TransportRequest[];
  insuranceRequests: InsuranceRequest[];
  forumThreads: ForumThread[];
  forumPosts: ForumPost[];
  marketplaceListings: MarketplaceListing[];
};

export const emptyPlatformDatabase = (): PlatformDatabase => ({
  photographers: [],
  coverageRequests: [],
  coverageApplications: [],
  transportOffers: [],
  transportRequests: [],
  insuranceRequests: [],
  forumThreads: [],
  forumPosts: [],
  marketplaceListings: [],
});
