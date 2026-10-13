import { mkdir, readFile, rename, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  type Accreditation,
  type AccreditationInput,
  type ContactInput,
  type ContactItem,
  type Coverage,
  type CoverageInput,
  type EventInput,
  type EventItem,
  emptyMediaKit,
  type MediaKit,
  type PressDatabase,
  type ReplacementApplication,
  type ReplacementApplicationInput,
  type ReplacementSearch,
  type ReplacementSearchInput,
} from "../../domain/press/types.js";

const now = () => new Date().toISOString();
const withMeta = <T extends object>(value: T): T & { id: string; createdAt: string; updatedAt: string } => ({
  ...value,
  id: randomUUID(),
  createdAt: now(),
  updatedAt: now(),
});

export interface PressRepository {
  snapshot(): Promise<PressDatabase>;
  createEvent(input: EventInput): Promise<EventItem>;
  updateEvent(id: string, patch: Partial<EventInput>): Promise<EventItem | undefined>;
  createContact(input: ContactInput): Promise<ContactItem>;
  updateContact(id: string, patch: Partial<ContactInput>): Promise<ContactItem | undefined>;
  createAccreditation(input: AccreditationInput): Promise<Accreditation>;
  updateAccreditation(id: string, patch: Partial<AccreditationInput>): Promise<Accreditation | undefined>;
  createCoverage(input: CoverageInput): Promise<Coverage>;
  updateCoverage(id: string, patch: Partial<CoverageInput>): Promise<Coverage | undefined>;
  createReplacementSearch(input: ReplacementSearchInput): Promise<ReplacementSearch>;
  updateReplacementSearch(id: string, patch: Partial<ReplacementSearchInput>): Promise<ReplacementSearch | undefined>;
  createReplacementApplication(input: ReplacementApplicationInput): Promise<ReplacementApplication>;
  updateReplacementApplication(
    id: string,
    patch: Partial<ReplacementApplicationInput>,
  ): Promise<ReplacementApplication | undefined>;
  updateMediaKit(patch: Partial<MediaKit>): Promise<MediaKit>;
  remove(
    collection:
      "events" | "contacts" | "accreditations" | "coverages" | "replacementSearches" | "replacementApplications",
    id: string,
  ): Promise<boolean>;
}

export class PressStore implements PressRepository {
  private readonly file: string;
  private readonly lock: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir = process.env.DATA_DIR ?? path.resolve("data")) {
    this.file = path.join(dataDir, "press.json");
    this.lock = path.join(dataDir, ".press.lock");
  }

  private async read(): Promise<PressDatabase> {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as Partial<PressDatabase>;
      return {
        events: parsed.events ?? [],
        contacts: parsed.contacts ?? [],
        accreditations: parsed.accreditations ?? [],
        coverages: parsed.coverages ?? [],
        replacementSearches: parsed.replacementSearches ?? [],
        replacementApplications: parsed.replacementApplications ?? [],
        mediaKit: { ...emptyMediaKit(), ...(parsed.mediaKit ?? {}) },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return {
        events: [],
        contacts: [],
        accreditations: [],
        coverages: [],
        replacementSearches: [],
        replacementApplications: [],
        mediaKit: emptyMediaKit(),
      };
    }
  }

  private async write(database: PressDatabase): Promise<void> {
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
        if (Date.now() >= deadline) throw new Error("No se pudo obtener el bloqueo de prensa");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      return await operation();
    } finally {
      await rmdir(this.lock).catch(() => undefined);
    }
  }

  async snapshot(): Promise<PressDatabase> {
    return this.read();
  }
  async createEvent(input: EventInput): Promise<EventItem> {
    return this.serialize(async () => {
      const db = await this.read();
      const item = withMeta(input);
      db.events.push(item);
      await this.write(db);
      return item;
    });
  }
  async updateEvent(id: string, patch: Partial<EventInput>): Promise<EventItem | undefined> {
    return this.serialize(async () => this.updateCollection("events", id, patch));
  }
  async createContact(input: ContactInput): Promise<ContactItem> {
    return this.serialize(async () => {
      const db = await this.read();
      const item = withMeta(input);
      db.contacts.push(item);
      await this.write(db);
      return item;
    });
  }
  async updateContact(id: string, patch: Partial<ContactInput>): Promise<ContactItem | undefined> {
    return this.serialize(async () => this.updateCollection("contacts", id, patch));
  }
  async createAccreditation(input: AccreditationInput): Promise<Accreditation> {
    return this.serialize(async () => {
      const db = await this.read();
      const item = withMeta(input);
      db.accreditations.push(item);
      await this.write(db);
      return item;
    });
  }
  async updateAccreditation(id: string, patch: Partial<AccreditationInput>): Promise<Accreditation | undefined> {
    return this.serialize(async () => this.updateCollection("accreditations", id, patch));
  }
  async createCoverage(input: CoverageInput): Promise<Coverage> {
    return this.serialize(async () => {
      const db = await this.read();
      const item = withMeta(input);
      db.coverages.push(item);
      await this.write(db);
      return item;
    });
  }
  async updateCoverage(id: string, patch: Partial<CoverageInput>): Promise<Coverage | undefined> {
    return this.serialize(async () => this.updateCollection("coverages", id, patch));
  }
  async createReplacementSearch(input: ReplacementSearchInput): Promise<ReplacementSearch> {
    return this.serialize(async () => {
      const db = await this.read();
      const item = withMeta(input);
      db.replacementSearches.push(item);
      await this.write(db);
      return item;
    });
  }
  async updateReplacementSearch(
    id: string,
    patch: Partial<ReplacementSearchInput>,
  ): Promise<ReplacementSearch | undefined> {
    return this.serialize(async () => this.updateCollection("replacementSearches", id, patch));
  }
  async createReplacementApplication(input: ReplacementApplicationInput): Promise<ReplacementApplication> {
    return this.serialize(async () => {
      const db = await this.read();
      const item = withMeta(input);
      db.replacementApplications.push(item);
      await this.write(db);
      return item;
    });
  }
  async updateReplacementApplication(
    id: string,
    patch: Partial<ReplacementApplicationInput>,
  ): Promise<ReplacementApplication | undefined> {
    return this.serialize(async () => this.updateCollection("replacementApplications", id, patch));
  }
  async updateMediaKit(patch: Partial<MediaKit>): Promise<MediaKit> {
    return this.serialize(async () => {
      const db = await this.read();
      db.mediaKit = { ...db.mediaKit, ...patch };
      await this.write(db);
      return db.mediaKit;
    });
  }
  async remove(
    collection:
      "events" | "contacts" | "accreditations" | "coverages" | "replacementSearches" | "replacementApplications",
    id: string,
  ): Promise<boolean> {
    return this.serialize(async () => {
      const db = await this.read();
      let removed = false;
      if (collection === "events") {
        const before = db.events.length;
        db.events = db.events.filter((item) => item.id !== id);
        removed = before !== db.events.length;
      } else if (collection === "contacts") {
        const before = db.contacts.length;
        db.contacts = db.contacts.filter((item) => item.id !== id);
        removed = before !== db.contacts.length;
      } else if (collection === "accreditations") {
        const before = db.accreditations.length;
        db.accreditations = db.accreditations.filter((item) => item.id !== id);
        removed = before !== db.accreditations.length;
      } else if (collection === "coverages") {
        const before = db.coverages.length;
        db.coverages = db.coverages.filter((item) => item.id !== id);
        removed = before !== db.coverages.length;
      } else if (collection === "replacementSearches") {
        const before = db.replacementSearches.length;
        db.replacementSearches = db.replacementSearches.filter((item) => item.id !== id);
        removed = before !== db.replacementSearches.length;
      } else {
        const before = db.replacementApplications.length;
        db.replacementApplications = db.replacementApplications.filter((item) => item.id !== id);
        removed = before !== db.replacementApplications.length;
      }
      if (!removed) return false;
      await this.write(db);
      return true;
    });
  }

  private async updateCollection<
    K extends
      "events" | "contacts" | "accreditations" | "coverages" | "replacementSearches" | "replacementApplications",
  >(
    collection: K,
    id: string,
    patch: Partial<PressDatabase[K][number]>,
  ): Promise<PressDatabase[K][number] | undefined> {
    const db = await this.read();
    const list = db[collection] as Array<PressDatabase[K][number]>;
    const index = list.findIndex((item) => item.id === id);
    if (index < 0) return undefined;
    const current = list[index]!;
    const updated = {
      ...current,
      ...patch,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: now(),
    } as PressDatabase[K][number];
    list[index] = updated;
    await this.write(db);
    return updated;
  }
}
