import { randomUUID } from "node:crypto";
import { MongoClient, type Collection, type Db } from "mongodb";
import { ContentManager } from "../../application/content-manager.js";
import { PressManager } from "../../application/press-manager.js";
import { DirectoryManager } from "../../application/directory-manager.js";
import {
  slugify,
  type ContentInput,
  type ContentItem,
  type ContentPatch,
  type ContentStatus,
} from "../../domain/content/types.js";
import {
  emptyMediaKit,
  type Accreditation,
  type AccreditationInput,
  type ContactInput,
  type ContactItem,
  type Coverage,
  type CoverageInput,
  type EventInput,
  type EventItem,
  type MediaKit,
  type PressDatabase,
  type ReplacementApplication,
  type ReplacementApplicationInput,
  type ReplacementSearch,
  type ReplacementSearchInput,
} from "../../domain/press/types.js";
import type { ContentRepository } from "./content-store.js";
import type { PressRepository } from "./press-store.js";
import type { DirectoryRepository } from "./directory-store.js";
import type { DirectoryInput, DirectoryItem, DirectoryPatch } from "../../domain/directory/types.js";
import type { ActiveUser, UserDirectory } from "../../interfaces/http/security.js";

type MongoRecord = Record<string, unknown> & { _id: string };
const timestamps = () => new Date().toISOString();
const cleanPatch = (patch: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));

/** MongoDB adapter for the editorial collection. IDs remain strings so API/MCP contracts do not change. */
export class MongoContentStore implements ContentRepository {
  constructor(private readonly collection: Collection<MongoRecord>) {}

  async init() {
    await Promise.all([
      this.collection.createIndex({ status: 1, updatedAt: -1 }),
      this.collection.createIndex({ slug: 1 }, { unique: true }),
      this.collection.createIndex({ scheduledAt: 1, status: 1 }),
    ]);
  }

  private fromDocument(document: MongoRecord): ContentItem {
    const { _id: _ignored, ...item } = document;
    return item as unknown as ContentItem;
  }

  async list(status?: ContentStatus): Promise<ContentItem[]> {
    const documents = await this.collection
      .find(status ? { status } : {})
      .sort({ updatedAt: -1 })
      .toArray();
    return documents.map((document) => this.fromDocument(document));
  }

  async get(id: string): Promise<ContentItem | undefined> {
    const document = await this.collection.findOne({ _id: id });
    return document ? this.fromDocument(document) : undefined;
  }

  async create(input: ContentInput): Promise<ContentItem> {
    const now = timestamps();
    const item: ContentItem = {
      ...input,
      id: randomUUID(),
      slug: input.slug || slugify(input.title),
      createdAt: now,
      updatedAt: now,
      publishedAt: null,
      remoteIds: {},
      lastError: null,
      attempts: 0,
      nextAttemptAt: null,
      containerId: null,
      publishedMediaId: null,
      viewCount: 0,
      instagramMetrics: null,
    };
    await this.collection.insertOne({ _id: item.id, ...item });
    return item;
  }

  async update(
    id: string,
    patch: ContentPatch &
      Partial<
        Pick<
          ContentItem,
          | "remoteIds"
          | "publishedAt"
          | "lastError"
          | "attempts"
          | "nextAttemptAt"
          | "containerId"
          | "publishedMediaId"
          | "instagramMetrics"
        >
      >,
  ): Promise<ContentItem | undefined> {
    const current = await this.get(id);
    if (!current) return undefined;
    const values = cleanPatch({
      ...patch,
      ...(patch.title ? { slug: slugify(patch.title) } : {}),
      updatedAt: timestamps(),
    });
    await this.collection.updateOne({ _id: id }, { $set: values });
    return this.get(id);
  }

  async remove(id: string): Promise<boolean> {
    return (await this.collection.deleteOne({ _id: id })).deletedCount === 1;
  }

  async claimForPublishing(id: string): Promise<ContentItem | undefined> {
    const result = await this.collection.findOneAndUpdate(
      { _id: id, status: { $in: ["approved", "scheduled", "failed"] } },
      {
        $set: { status: "publishing", updatedAt: timestamps() },
        $setOnInsert: { attempts: 0 },
      },
      { returnDocument: "after" },
    );
    return result ? this.fromDocument(result) : undefined;
  }

  async incrementViews(id: string): Promise<ContentItem | undefined> {
    const result = await this.collection.findOneAndUpdate(
      { _id: id },
      { $inc: { viewCount: 1 }, $set: { updatedAt: timestamps() } } as never,
      { returnDocument: "after" },
    );
    return result ? this.fromDocument(result) : undefined;
  }
}

export class MongoPressStore implements PressRepository {
  constructor(private readonly db: Db) {}

  private collection<T extends MongoRecord>(name: string): Collection<T> {
    return this.db.collection<T>(name);
  }
  private async one<T extends MongoRecord>(name: string, id: string): Promise<T | undefined> {
    const result = await this.collection<T>(name).findOne({ _id: id } as never);
    return result ? (result as T) : undefined;
  }
  private withoutId<T extends MongoRecord>(document: T): Omit<T, "_id"> {
    const { _id: _ignored, ...value } = document;
    return value;
  }

  async init() {
    await Promise.all([
      this.collection<MongoRecord>("press_events").createIndex({
        status: 1,
        startsAt: 1,
      }),
      this.collection<MongoRecord>("press_events").createIndex({
        artist: 1,
        city: 1,
      }),
      this.collection<MongoRecord>("press_contacts").createIndex({
        type: 1,
        organization: 1,
      }),
      this.collection<MongoRecord>("press_accreditations").createIndex({
        status: 1,
        followUpAt: 1,
      }),
      this.collection<MongoRecord>("press_accreditations").createIndex({
        eventId: 1,
        contactId: 1,
      }),
      this.collection<MongoRecord>("press_coverages").createIndex({
        eventId: 1,
        publishedAt: -1,
      }),
      this.collection<MongoRecord>("press_replacement_searches").createIndex({ status: 1, startsAt: 1 }),
      this.collection<MongoRecord>("press_replacement_applications").createIndex({ searchId: 1, status: 1 }),
      this.collection<MongoRecord>("press_settings").createIndex({ _id: 1 }, { unique: true }),
    ]);
  }

  async snapshot(): Promise<PressDatabase> {
    const [events, contacts, accreditations, coverages, replacementSearches, replacementApplications, mediaKit] =
      await Promise.all([
        this.collection<MongoRecord>("press_events").find().sort({ updatedAt: -1 }).toArray(),
        this.collection<MongoRecord>("press_contacts").find().sort({ updatedAt: -1 }).toArray(),
        this.collection<MongoRecord>("press_accreditations").find().sort({ updatedAt: -1 }).toArray(),
        this.collection<MongoRecord>("press_coverages").find().sort({ publishedAt: -1 }).toArray(),
        this.collection<MongoRecord>("press_replacement_searches").find().sort({ updatedAt: -1 }).toArray(),
        this.collection<MongoRecord>("press_replacement_applications").find().sort({ updatedAt: -1 }).toArray(),
        this.one<MongoRecord>("press_settings", "mediaKit"),
      ]);
    return {
      events: events.map((item) => this.withoutId(item) as unknown as EventItem),
      contacts: contacts.map((item) => this.withoutId(item) as unknown as ContactItem),
      accreditations: accreditations.map((item) => this.withoutId(item) as unknown as Accreditation),
      coverages: coverages.map((item) => this.withoutId(item) as unknown as Coverage),
      replacementSearches: replacementSearches.map((item) => this.withoutId(item) as unknown as ReplacementSearch),
      replacementApplications: replacementApplications.map(
        (item) => this.withoutId(item) as unknown as ReplacementApplication,
      ),
      mediaKit: mediaKit ? (this.withoutId(mediaKit) as unknown as MediaKit) : emptyMediaKit(),
    };
  }

  async createEvent(input: EventInput): Promise<EventItem> {
    return this.create("press_events", input);
  }
  async updateEvent(id: string, patch: Partial<EventInput>): Promise<EventItem | undefined> {
    return this.update("press_events", id, patch);
  }
  async createContact(input: ContactInput): Promise<ContactItem> {
    return this.create("press_contacts", input);
  }
  async updateContact(id: string, patch: Partial<ContactInput>): Promise<ContactItem | undefined> {
    return this.update("press_contacts", id, patch);
  }
  async createAccreditation(input: AccreditationInput): Promise<Accreditation> {
    return this.create("press_accreditations", input);
  }
  async updateAccreditation(id: string, patch: Partial<AccreditationInput>): Promise<Accreditation | undefined> {
    return this.update("press_accreditations", id, patch);
  }
  async createCoverage(input: CoverageInput): Promise<Coverage> {
    return this.create("press_coverages", input);
  }
  async updateCoverage(id: string, patch: Partial<CoverageInput>): Promise<Coverage | undefined> {
    return this.update("press_coverages", id, patch);
  }
  async createReplacementSearch(input: ReplacementSearchInput): Promise<ReplacementSearch> {
    return this.create("press_replacement_searches", input);
  }
  async updateReplacementSearch(
    id: string,
    patch: Partial<ReplacementSearchInput>,
  ): Promise<ReplacementSearch | undefined> {
    return this.update("press_replacement_searches", id, patch);
  }
  async createReplacementApplication(input: ReplacementApplicationInput): Promise<ReplacementApplication> {
    return this.create("press_replacement_applications", input);
  }
  async updateReplacementApplication(
    id: string,
    patch: Partial<ReplacementApplicationInput>,
  ): Promise<ReplacementApplication | undefined> {
    return this.update("press_replacement_applications", id, patch);
  }

  private async create<T extends object>(
    collection: string,
    input: T,
  ): Promise<T & { id: string; createdAt: string; updatedAt: string }> {
    const item = {
      ...input,
      id: randomUUID(),
      createdAt: timestamps(),
      updatedAt: timestamps(),
    };
    await this.collection<MongoRecord>(collection).insertOne({
      _id: item.id,
      ...item,
    });
    return item;
  }

  private async update<T extends object>(
    collection: string,
    id: string,
    patch: Partial<T>,
  ): Promise<(T & { id: string; createdAt: string; updatedAt: string }) | undefined> {
    const values = cleanPatch({ ...patch, updatedAt: timestamps() });
    const result = await this.collection<MongoRecord>(collection).findOneAndUpdate(
      { _id: id },
      { $set: values },
      { returnDocument: "after" },
    );
    return result
      ? (this.withoutId(result) as unknown as T & {
          id: string;
          createdAt: string;
          updatedAt: string;
        })
      : undefined;
  }

  async updateMediaKit(patch: Partial<MediaKit>): Promise<MediaKit> {
    const collection = this.collection<MongoRecord>("press_settings");
    const result = await collection.findOneAndUpdate(
      { _id: "mediaKit" },
      { $set: cleanPatch(patch) },
      { upsert: true, returnDocument: "after" },
    );
    return {
      ...emptyMediaKit(),
      ...this.withoutId(result as MongoRecord),
    } as MediaKit;
  }

  async remove(
    collection:
      "events" | "contacts" | "accreditations" | "coverages" | "replacementSearches" | "replacementApplications",
    id: string,
  ): Promise<boolean> {
    const names = {
      events: "press_events",
      contacts: "press_contacts",
      accreditations: "press_accreditations",
      coverages: "press_coverages",
      replacementSearches: "press_replacement_searches",
      replacementApplications: "press_replacement_applications",
    } as const;
    return (
      (
        await this.collection<MongoRecord>(names[collection]).deleteOne({
          _id: id,
        })
      ).deletedCount === 1
    );
  }
}

export class MongoUserDirectory implements UserDirectory {
  constructor(private readonly collection: Collection<MongoRecord>) {}
  async init() {
    await Promise.all([
      this.collection.createIndex({ active: 1, roles: 1 }),
      this.collection.createIndex({ active: 1, roles: 1, permissions: 1 }),
      this.collection.createIndex({ username: 1 }, { unique: true, sparse: true }),
      this.collection.createIndex({ email: 1 }, { unique: true, sparse: true }),
    ]);
  }
  async findActiveUser(id: string): Promise<ActiveUser | undefined> {
    const user = await this.collection.findOne({
      _id: id,
      active: { $ne: false },
      roles: { $exists: true, $type: "array", $ne: [] },
      permissions: { $exists: true, $type: "array" },
    } as never);
    return user
      ? {
          id: String(user._id),
          roles: user.roles as ActiveUser["roles"],
          permissions: user.permissions as ActiveUser["permissions"],
          active: user.active as boolean | undefined,
        }
      : undefined;
  }
  async findByIdentifier(identifier: string): Promise<(ActiveUser & { passwordHash?: string }) | undefined> {
    const user = await this.collection.findOne({
      $or: [{ _id: identifier }, { email: identifier.toLowerCase() }, { username: identifier.toLowerCase() }],
      active: { $ne: false },
      roles: { $exists: true, $type: "array", $ne: [] },
      permissions: { $exists: true, $type: "array" },
    } as never);
    return user
      ? {
          id: String(user._id),
          roles: user.roles as ActiveUser["roles"],
          permissions: user.permissions as ActiveUser["permissions"],
          active: user.active as boolean | undefined,
          passwordHash: typeof user.passwordHash === "string" ? user.passwordHash : undefined,
        }
      : undefined;
  }
}

export class MongoDirectoryStore implements DirectoryRepository {
  constructor(private readonly collection: Collection<MongoRecord>) {}
  async init() {
    await Promise.all([
      this.collection.createIndex({ name: 1, status: 1 }),
      this.collection.createIndex({ kind: 1, city: 1 }),
      this.collection.createIndex({ tags: 1 }),
      this.collection.createIndex({ latitude: 1, longitude: 1 }),
      this.collection.createIndex({ verificationStatus: 1, reliabilityScore: -1 }),
    ]);
  }
  private from(document: MongoRecord): DirectoryItem {
    const { _id: _ignored, ...item } = document;
    return item as unknown as DirectoryItem;
  }
  private normalize(item: DirectoryItem): DirectoryItem {
    return {
      verificationStatus: "unverified",
      reliabilityScore: 0,
      lastVerifiedAt: null,
      verifiedBy: null,
      verificationNotes: "",
      ...(item as unknown as Record<string, unknown>),
    } as DirectoryItem;
  }
  async list() {
    return (await this.collection.find().sort({ updatedAt: -1 }).toArray()).map((item) =>
      this.normalize(this.from(item)),
    );
  }
  async get(id: string) {
    const item = await this.collection.findOne({ _id: id });
    return item ? this.normalize(this.from(item)) : undefined;
  }
  async create(input: DirectoryInput) {
    const now = new Date().toISOString();
    const item = { ...input, id: randomUUID(), createdAt: now, updatedAt: now };
    await this.collection.insertOne({ _id: item.id, ...item });
    return item;
  }
  async update(id: string, patch: DirectoryPatch) {
    const result = await this.collection.findOneAndUpdate(
      { _id: id },
      { $set: { ...patch, updatedAt: new Date().toISOString() } },
      { returnDocument: "after" },
    );
    return result ? this.from(result) : undefined;
  }
  async remove(id: string) {
    return (await this.collection.deleteOne({ _id: id })).deletedCount === 1;
  }
}

export type MongoPersistence = {
  client: MongoClient;
  content: MongoContentStore;
  press: MongoPressStore;
  users: MongoUserDirectory;
  directory: MongoDirectoryStore;
};

export const createMongoPersistence = async (): Promise<MongoPersistence | undefined> => {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI es obligatorio: el backend no inicia sin MongoDB");
  // Small long-running editorial service: conservative pool and bounded waits avoid idle Atlas connections and hung requests.
  const client = new MongoClient(uri, {
    maxPoolSize: 20,
    minPoolSize: 0,
    maxIdleTimeMS: 300_000,
    connectTimeoutMS: 10_000,
    serverSelectionTimeoutMS: 5_000,
    socketTimeoutMS: 30_000,
    waitQueueTimeoutMS: 5_000,
  });
  await client.connect();
  const db = client.db(process.env.MONGODB_DB ?? "medio_under");
  const content = new MongoContentStore(db.collection<MongoRecord>("contents"));
  const press = new MongoPressStore(db);
  const users = new MongoUserDirectory(db.collection<MongoRecord>("users"));
  const directory = new MongoDirectoryStore(db.collection<MongoRecord>("directory"));
  await Promise.all([content.init(), press.init(), users.init(), directory.init()]);
  return { client, content, press, users, directory };
};

export const createManagers = async () => {
  const persistence = await createMongoPersistence();
  return {
    persistence,
    manager: new ContentManager(persistence?.content),
    press: new PressManager(persistence?.press),
    users: persistence?.users,
    directory: new DirectoryManager(persistence?.directory),
  };
};
