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
    const patch = parsePatch(coverageApplicationSchema, input);
    const snapshot = await this.store.snapshot();
    const current = snapshot.coverageApplications.find((item) => item.id === id);
    if (!current) return undefined;

    if (patch.status === "accepted") {
      const competing = snapshot.coverageApplications.filter(
        (item) =>
          item.requestId === current.requestId && item.id !== id && ["pending", "shortlisted"].includes(item.status),
      );
      await Promise.all(competing.map((item) => this.store.updateCoverageApplication(item.id, { status: "rejected" })));
      await this.store.updateCoverageRequest(current.requestId, { status: "assigned" });
    }
    return this.store.updateCoverageApplication(id, patch);
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
    if (parsed.offerId) {
      const offer = snapshot.transportOffers.find(
        (item) => item.eventId === parsed.eventId && item.id === parsed.offerId && item.status === "open",
      );
      if (!offer) throw new Error("Traslado no encontrado");
      const confirmed = snapshot.transportRequests
        .filter((item) => item.offerId === offer.id && item.status === "confirmed")
        .reduce((total, item) => total + item.partySize, 0);
      if (confirmed + parsed.partySize > offer.seats) throw new Error("No quedan cupos para este traslado");
    }
    return this.store.createTransportRequest(parsed);
  }
  async updateTransportRequest(id: string, input: unknown) {
    const patch = parsePatch(transportRequestSchema, input);
    const snapshot = await this.store.snapshot();
    const current = snapshot.transportRequests.find((item) => item.id === id);
    if (!current) return undefined;
    const nextOfferId = patch.offerId === undefined ? current.offerId : patch.offerId;
    const nextStatus = patch.status === undefined ? current.status : patch.status;
    const nextPartySize = patch.partySize === undefined ? current.partySize : patch.partySize;
    if (nextOfferId && nextStatus === "confirmed") {
      const offer = snapshot.transportOffers.find(
        (item) => item.id === nextOfferId && item.eventId === current.eventId && item.status === "open",
      );
      if (!offer) throw new Error("Traslado no encontrado");
      const confirmed = snapshot.transportRequests
        .filter((item) => item.offerId === offer.id && item.id !== id && item.status === "confirmed")
        .reduce((total, item) => total + item.partySize, 0);
      if (confirmed + nextPartySize > offer.seats) throw new Error("No quedan cupos para este traslado");
    }
    return this.store.updateTransportRequest(id, patch);
  }

  async createInsuranceRequest(input: unknown) {
    return this.store.createInsuranceRequest(insuranceRequestSchema.parse(input));
  }
  async updateInsuranceRequest(id: string, input: unknown) {
    return this.store.updateInsuranceRequest(id, parsePatch(insuranceRequestSchema, input));
  }
  async renewInsuranceRequest(id: string) {
    const snapshot = await this.store.snapshot();
    const current = snapshot.insuranceRequests.find((item) => item.id === id);
    if (!current) return undefined;
    const {
      id: _id,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      providerName: _providerName,
      quoteLabel: _quoteLabel,
      quoteUrl: _quoteUrl,
      policyNumber: _policyNumber,
      policyUrl: _policyUrl,
      internalNotes: _internalNotes,
      mailThreadId: _mailThreadId,
      notificationStatus: _notificationStatus,
      notificationTo: _notificationTo,
      contractStatus: _contractStatus,
      contractedAt: _contractedAt,
      commissionLabel: _commissionLabel,
      commissionNotes: _commissionNotes,
      renewedFromId: _renewedFromId,
      status: _status,
      ...base
    } = current;
    return this.store.createInsuranceRequest(
      insuranceRequestSchema.parse({
        ...base,
        startsAt: null,
        endsAt: null,
        renewedFromId: current.id,
        status: "new",
      }),
    );
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
        coverageRequests
          .filter((item) => item.status === "open" && (!eventId || item.eventId === eventId))
          .map(({ requesterEmail: _requesterEmail, ...item }) => item),
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
      coverageRequests: snapshot.coverageRequests
        .filter((item) => item.eventId === event.id && item.status === "open")
        .map(({ requesterEmail: _requesterEmail, ...item }) => item),
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
