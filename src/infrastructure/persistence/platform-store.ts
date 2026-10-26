import { mkdir, readFile, rename, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  emptyPlatformDatabase,
  type CoverageApplication,
  type CoverageApplicationInput,
  type CoverageRequest,
  type CoverageRequestInput,
  type ForumPost,
  type ForumPostInput,
  type ForumThread,
  type ForumThreadInput,
  type InsuranceRequest,
  type InsuranceRequestInput,
  type MarketplaceListing,
  type MarketplaceListingInput,
  type PhotographerProfile,
  type PhotographerProfileInput,
  type PlatformDatabase,
  type TransportOffer,
  type TransportOfferInput,
  type TransportRequest,
  type TransportRequestInput,
} from "../../domain/platform/types.js";

const now = () => new Date().toISOString();
const withMeta = <T extends object>(value: T): T & { id: string; createdAt: string; updatedAt: string } => ({
  ...value,
  id: randomUUID(),
  createdAt: now(),
  updatedAt: now(),
});

export interface PlatformRepository {
  snapshot(): Promise<PlatformDatabase>;
  createPhotographer(input: PhotographerProfileInput): Promise<PhotographerProfile>;
  updatePhotographer(id: string, patch: Partial<PhotographerProfileInput>): Promise<PhotographerProfile | undefined>;
  createCoverageRequest(input: CoverageRequestInput): Promise<CoverageRequest>;
  updateCoverageRequest(id: string, patch: Partial<CoverageRequestInput>): Promise<CoverageRequest | undefined>;
  createCoverageApplication(input: CoverageApplicationInput): Promise<CoverageApplication>;
  updateCoverageApplication(
    id: string,
    patch: Partial<CoverageApplicationInput>,
  ): Promise<CoverageApplication | undefined>;
  createTransportOffer(input: TransportOfferInput): Promise<TransportOffer>;
  updateTransportOffer(id: string, patch: Partial<TransportOfferInput>): Promise<TransportOffer | undefined>;
  createTransportRequest(input: TransportRequestInput): Promise<TransportRequest>;
  updateTransportRequest(id: string, patch: Partial<TransportRequestInput>): Promise<TransportRequest | undefined>;
  createInsuranceRequest(input: InsuranceRequestInput): Promise<InsuranceRequest>;
  updateInsuranceRequest(id: string, patch: Partial<InsuranceRequestInput>): Promise<InsuranceRequest | undefined>;
  createForumThread(input: ForumThreadInput): Promise<ForumThread>;
  updateForumThread(id: string, patch: Partial<ForumThreadInput>): Promise<ForumThread | undefined>;
  createForumPost(input: ForumPostInput): Promise<ForumPost>;
  updateForumPost(id: string, patch: Partial<ForumPostInput>): Promise<ForumPost | undefined>;
  createMarketplaceListing(input: MarketplaceListingInput): Promise<MarketplaceListing>;
  updateMarketplaceListing(
    id: string,
    patch: Partial<MarketplaceListingInput>,
  ): Promise<MarketplaceListing | undefined>;
}

type PlatformCollection = keyof PlatformDatabase;

export class PlatformStore implements PlatformRepository {
  private readonly file: string;
  private readonly lock: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir = process.env.DATA_DIR ?? path.resolve("data")) {
    this.file = path.join(dataDir, "platform.json");
    this.lock = path.join(dataDir, ".platform.lock");
  }

  private async read(): Promise<PlatformDatabase> {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as Partial<PlatformDatabase>;
      return { ...emptyPlatformDatabase(), ...parsed };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return emptyPlatformDatabase();
    }
  }

  private async write(database: PlatformDatabase) {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(database, null, 2)}\n`, "utf8");
    await rename(temp, this.file);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(
      () => this.withFileLock(operation),
      () => this.withFileLock(operation),
    );
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const deadline = Date.now() + 5_000;
    while (true) {
      try {
        await mkdir(this.lock);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const lockInfo = await stat(this.lock).catch(() => null);
        if (!lockInfo) continue;
        if (Date.now() - lockInfo.mtimeMs > 30_000) await rmdir(this.lock).catch(() => undefined);
        if (Date.now() >= deadline) throw new Error("No se pudo obtener el bloqueo de la plataforma");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      return await operation();
    } finally {
      await rmdir(this.lock).catch(() => undefined);
    }
  }

  async snapshot() {
    return this.read();
  }

  private async create<T extends object, K extends PlatformCollection>(collection: K, input: T) {
    return this.serialize(async () => {
      const database = await this.read();
      const item = withMeta(input) as PlatformDatabase[K][number];
      (database[collection] as Array<PlatformDatabase[K][number]>).push(item);
      await this.write(database);
      return item;
    });
  }

  private async update<K extends PlatformCollection>(
    collection: K,
    id: string,
    patch: Partial<PlatformDatabase[K][number]>,
  ) {
    return this.serialize(async () => {
      const database = await this.read();
      const items = database[collection] as Array<PlatformDatabase[K][number]>;
      const index = items.findIndex((item) => item.id === id);
      if (index < 0) return undefined;
      const current = items[index]!;
      const updated = { ...current, ...patch, id: current.id, createdAt: current.createdAt, updatedAt: now() };
      items[index] = updated;
      await this.write(database);
      return updated;
    });
  }

  createPhotographer(input: PhotographerProfileInput) {
    return this.create("photographers", input);
  }
  updatePhotographer(id: string, patch: Partial<PhotographerProfileInput>) {
    return this.update("photographers", id, patch);
  }
  createCoverageRequest(input: CoverageRequestInput) {
    return this.create("coverageRequests", input);
  }
  updateCoverageRequest(id: string, patch: Partial<CoverageRequestInput>) {
    return this.update("coverageRequests", id, patch);
  }
  createCoverageApplication(input: CoverageApplicationInput) {
    return this.create("coverageApplications", input);
  }
  updateCoverageApplication(id: string, patch: Partial<CoverageApplicationInput>) {
    return this.update("coverageApplications", id, patch);
  }
  createTransportOffer(input: TransportOfferInput) {
    return this.create("transportOffers", input);
  }
  updateTransportOffer(id: string, patch: Partial<TransportOfferInput>) {
    return this.update("transportOffers", id, patch);
  }
  createTransportRequest(input: TransportRequestInput) {
    return this.create("transportRequests", input);
  }
  updateTransportRequest(id: string, patch: Partial<TransportRequestInput>) {
    return this.update("transportRequests", id, patch);
  }
  createInsuranceRequest(input: InsuranceRequestInput) {
    return this.create("insuranceRequests", input);
  }
  updateInsuranceRequest(id: string, patch: Partial<InsuranceRequestInput>) {
    return this.update("insuranceRequests", id, patch);
  }
  createForumThread(input: ForumThreadInput) {
    return this.create("forumThreads", input);
  }
  updateForumThread(id: string, patch: Partial<ForumThreadInput>) {
    return this.update("forumThreads", id, patch);
  }
  createForumPost(input: ForumPostInput) {
    return this.create("forumPosts", input);
  }
  updateForumPost(id: string, patch: Partial<ForumPostInput>) {
    return this.update("forumPosts", id, patch);
  }
  createMarketplaceListing(input: MarketplaceListingInput) {
    return this.create("marketplaceListings", input);
  }
  updateMarketplaceListing(id: string, patch: Partial<MarketplaceListingInput>) {
    return this.update("marketplaceListings", id, patch);
  }
}
