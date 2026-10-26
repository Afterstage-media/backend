import { parsePatch } from "../domain/parse-patch.js";
import {
  coverageApplicationSchema,
  coverageRequestSchema,
  forumPostSchema,
  forumThreadSchema,
  insuranceRequestSchema,
  marketplaceListingSchema,
  photographerProfileSchema,
  transportOfferSchema,
  transportRequestSchema,
  type CoverageApplicationInput,
  type CoverageRequestInput,
  type ForumPostInput,
  type ForumThreadInput,
  type InsuranceRequestInput,
  type MarketplaceListingInput,
  type PhotographerProfileInput,
  type TransportOfferInput,
  type TransportRequestInput,
} from "../domain/platform/types.js";
import { PlatformStore, type PlatformRepository } from "../infrastructure/persistence/platform-store.js";

export class PlatformManager {
  constructor(readonly store: PlatformRepository = new PlatformStore()) {}

  snapshot() {
    return this.store.snapshot();
  }

  async createPhotographer(input: unknown) {
    return this.store.createPhotographer(photographerProfileSchema.parse(input));
  }
  async updatePhotographer(id: string, input: unknown) {
    const patch = parsePatch(photographerProfileSchema, input);
    return this.store.updatePhotographer(id, patch);
  }

  async createCoverageRequest(input: unknown) {
    return this.store.createCoverageRequest(coverageRequestSchema.parse(input));
  }
  async updateCoverageRequest(id: string, input: unknown) {
    return this.store.updateCoverageRequest(id, parsePatch(coverageRequestSchema, input));
  }
  async createCoverageApplication(input: unknown) {
    const parsed = coverageApplicationSchema.parse(input);
    const snapshot = await this.store.snapshot();
    const request = snapshot.coverageRequests.find((item) => item.id === parsed.requestId);
    if (!request) throw new Error("Búsqueda de cobertura no encontrada");
    if (!["open", "screening"].includes(request.status)) throw new Error("La búsqueda ya no acepta postulaciones");
    if (
      snapshot.coverageApplications.some(
        (item) =>
          item.requestId === parsed.requestId &&
          item.applicantEmail.toLowerCase() === parsed.applicantEmail.toLowerCase() &&
          item.status !== "withdrawn",
      )
    )
      throw new Error("Ya existe una postulación con ese email");
    if (parsed.photographerId && !snapshot.photographers.some((item) => item.id === parsed.photographerId))
      throw new Error("Fotógrafo no encontrado");
    return this.store.createCoverageApplication(parsed);
  }
  async updateCoverageApplication(id: string, input: unknown) {
    return this.store.updateCoverageApplication(id, parsePatch(coverageApplicationSchema, input));
  }

  async createTransportOffer(input: unknown) {
    return this.store.createTransportOffer(transportOfferSchema.parse(input));
  }
  async updateTransportOffer(id: string, input: unknown) {
    return this.store.updateTransportOffer(id, parsePatch(transportOfferSchema, input));
  }
  async createTransportRequest(input: unknown) {
    const parsed = transportRequestSchema.parse(input);
    const snapshot = await this.store.snapshot();
    if (
      parsed.offerId &&
      !snapshot.transportOffers.some((item) => item.eventId === parsed.eventId && item.id === parsed.offerId)
    )
      throw new Error("Traslado no encontrado");
    return this.store.createTransportRequest(parsed);
  }
  async updateTransportRequest(id: string, input: unknown) {
    return this.store.updateTransportRequest(id, parsePatch(transportRequestSchema, input));
  }

  async createInsuranceRequest(input: unknown) {
    return this.store.createInsuranceRequest(insuranceRequestSchema.parse(input));
  }
  async updateInsuranceRequest(id: string, input: unknown) {
    return this.store.updateInsuranceRequest(id, parsePatch(insuranceRequestSchema, input));
  }

  async createForumThread(input: unknown) {
    return this.store.createForumThread(forumThreadSchema.parse(input));
  }
  async updateForumThread(id: string, input: unknown) {
    return this.store.updateForumThread(id, parsePatch(forumThreadSchema, input));
  }
  async createForumPost(input: unknown) {
    const parsed = forumPostSchema.parse(input);
    const snapshot = await this.store.snapshot();
    if (!snapshot.forumThreads.some((item) => item.id === parsed.threadId && item.status === "visible"))
      throw new Error("Conversación no encontrada");
    return this.store.createForumPost(parsed);
  }
  async updateForumPost(id: string, input: unknown) {
    return this.store.updateForumPost(id, parsePatch(forumPostSchema, input));
  }

  async createMarketplaceListing(input: unknown) {
    return this.store.createMarketplaceListing(marketplaceListingSchema.parse(input));
  }
  async updateMarketplaceListing(id: string, input: unknown) {
    return this.store.updateMarketplaceListing(id, parsePatch(marketplaceListingSchema, input));
  }

  publicPhotographers(query = "", city = "") {
    return this.store.snapshot().then(({ photographers }) =>
      photographers
        .filter((item) => item.status === "published")
        .filter(
          (item) =>
            !query ||
            `${item.name} ${item.bio} ${item.specialties.join(" ")}`.toLowerCase().includes(query.toLowerCase()),
        )
        .filter((item) => !city || item.city.toLowerCase() === city.toLowerCase())
        .map(({ contactEmail: _contactEmail, ...item }) => item),
    );
  }

  publicCoverageRequests(eventId?: string) {
    return this.store
      .snapshot()
      .then(({ coverageRequests }) =>
        coverageRequests.filter((item) => item.status === "open" && (!eventId || item.eventId === eventId)),
      );
  }

  publicMarketplace(category?: string) {
    return this.store
      .snapshot()
      .then(({ marketplaceListings }) =>
        marketplaceListings.filter((item) => item.active && (!category || item.category === category)),
      );
  }

  async eventHub(event: Record<string, unknown> & { id: string }) {
    const snapshot = await this.store.snapshot();
    return {
      event,
      coverageRequests: snapshot.coverageRequests.filter((item) => item.eventId === event.id && item.status === "open"),
      transportOffers: snapshot.transportOffers.filter((item) => item.eventId === event.id && item.status === "open"),
      threads: snapshot.forumThreads
        .filter((item) => item.eventId === event.id && item.status === "visible")
        .map((thread) => ({
          ...thread,
          authorEmail: undefined,
          posts: snapshot.forumPosts
            .filter((post) => post.threadId === thread.id && post.status === "visible")
            .map(({ authorEmail: _authorEmail, ...post }) => post),
        })),
      marketplace: snapshot.marketplaceListings.filter((item) => item.active),
    };
  }
}

export type {
  CoverageApplicationInput,
  CoverageRequestInput,
  ForumPostInput,
  ForumThreadInput,
  InsuranceRequestInput,
  MarketplaceListingInput,
  PhotographerProfileInput,
  TransportOfferInput,
  TransportRequestInput,
};
