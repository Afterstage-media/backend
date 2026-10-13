import {
  directoryInputSchema,
  directoryVerificationSchema,
  socialLinksPatchSchema,
  type DirectoryItem,
} from "../domain/directory/types.js";
import { parsePatch } from "../domain/parse-patch.js";
import { DirectoryStore, type DirectoryRepository } from "../infrastructure/persistence/directory-store.js";
import { distanceKm } from "../domain/location.js";

export class DirectoryManager {
  constructor(readonly store: DirectoryRepository = new DirectoryStore()) {}
  async list(query = "", location?: { lat: number; lng: number; radiusKm: number }) {
    const items = await this.store.list();
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return items.flatMap((item) => {
      const haystack =
        `${item.name} ${item.aliases.join(" ")} ${item.kind} ${item.city} ${item.tags.join(" ")} ${item.contacts.map((contact) => `${contact.name} ${contact.role}`).join(" ")}`.toLowerCase();
      if (terms.length && !terms.every((term) => haystack.includes(term))) return [];
      if (!location || item.latitude === null || item.longitude === null) return location ? [] : [item];
      const distance = distanceKm(location.lat, location.lng, item.latitude, item.longitude);
      return distance <= location.radiusKm ? [{ ...item, distanceKm: Math.round(distance * 10) / 10 }] : [];
    });
  }
  async get(id: string): Promise<DirectoryItem> {
    const item = await this.store.get(id);
    if (!item) throw new Error("Entrada del directorio no encontrada");
    return item;
  }
  async create(input: unknown) {
    const parsed = directoryInputSchema.parse(input);
    const duplicate = (await this.list()).find(
      (item) => item.name.toLowerCase() === parsed.name.toLowerCase() && item.status === "active",
    );
    if (duplicate) throw new Error("Ya existe una entrada activa con ese nombre");
    return this.store.create(parsed);
  }
  async update(id: string, input: unknown) {
    const current = await this.get(id);
    const patch = parsePatch(directoryInputSchema, input);
    delete patch.verificationStatus;
    delete patch.reliabilityScore;
    delete patch.lastVerifiedAt;
    delete patch.verifiedBy;
    delete patch.verificationNotes;
    if (input && typeof input === "object" && !Array.isArray(input) && "socials" in input) {
      patch.socials = socialLinksPatchSchema.parse((input as { socials: unknown }).socials) as typeof patch.socials;
    }
    if (patch.name && patch.name.toLowerCase() !== current.name.toLowerCase()) {
      const duplicate = (await this.list()).find(
        (item) => item.id !== id && item.status === "active" && item.name.toLowerCase() === patch.name!.toLowerCase(),
      );
      if (duplicate) throw new Error("Ya existe una entrada activa con ese nombre");
    }
    return this.store.update(
      id,
      patch.socials ? { ...patch, socials: { ...current.socials, ...patch.socials } } : patch,
    );
  }
  async remove(id: string) {
    await this.get(id);
    return this.store.remove(id);
  }

  async verify(id: string, input: unknown, actorId: string): Promise<DirectoryItem> {
    await this.get(id);
    const verification = directoryVerificationSchema.parse(input);
    const defaults = { unverified: 0, verified: 100, stale: 50, incorrect: 0 } as const;
    const updated = await this.store.update(id, {
      verificationStatus: verification.status,
      reliabilityScore: verification.reliabilityScore ?? defaults[verification.status],
      lastVerifiedAt: new Date().toISOString(),
      verifiedBy: actorId,
      verificationNotes: verification.notes,
    });
    if (!updated) throw new Error("Entrada del directorio no encontrada");
    return updated;
  }
}
