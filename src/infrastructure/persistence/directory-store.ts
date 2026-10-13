import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DirectoryInput, DirectoryItem, DirectoryPatch } from "../../domain/directory/types.js";

export interface DirectoryRepository {
  list(): Promise<DirectoryItem[]>;
  get(id: string): Promise<DirectoryItem | undefined>;
  create(input: DirectoryInput): Promise<DirectoryItem>;
  update(id: string, patch: DirectoryPatch): Promise<DirectoryItem | undefined>;
  remove(id: string): Promise<boolean>;
}
type Database = { entries: DirectoryItem[] };
const normalizeDirectory = (entry: DirectoryItem): DirectoryItem =>
  ({
    verificationStatus: "unverified",
    reliabilityScore: 0,
    lastVerifiedAt: null,
    verifiedBy: null,
    verificationNotes: "",
    ...(entry as unknown as Record<string, unknown>),
  }) as DirectoryItem;

export class DirectoryStore implements DirectoryRepository {
  private readonly file: string;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(dataDir = process.env.DATA_DIR ?? path.resolve("data")) {
    this.file = path.join(dataDir, "directory.json");
  }
  private async read(): Promise<Database> {
    try {
      return {
        entries: ((JSON.parse(await readFile(this.file, "utf8")) as Partial<Database>).entries ?? []).map(
          normalizeDirectory,
        ),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { entries: [] };
    }
  }
  private write(database: Database): Promise<void> {
    return mkdir(path.dirname(this.file), { recursive: true }).then(async () => {
      const temp = `${this.file}.${process.pid}.tmp`;
      await writeFile(temp, `${JSON.stringify(database, null, 2)}\n`, "utf8");
      await rename(temp, this.file);
    });
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
  async list() {
    return (await this.read()).entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async get(id: string) {
    return (await this.read()).entries.find((entry) => entry.id === id);
  }
  async create(input: DirectoryInput) {
    return this.serialize(async () => {
      const db = await this.read();
      const now = new Date().toISOString();
      const item = {
        ...input,
        id: randomUUID(),
        createdAt: now,
        updatedAt: now,
      };
      db.entries.push(item);
      await this.write(db);
      return item;
    });
  }
  async update(id: string, patch: DirectoryPatch) {
    return this.serialize(async () => {
      const db = await this.read();
      const index = db.entries.findIndex((entry) => entry.id === id);
      if (index < 0) return undefined;
      db.entries[index] = {
        ...db.entries[index]!,
        ...patch,
        id,
        updatedAt: new Date().toISOString(),
      };
      await this.write(db);
      return db.entries[index];
    });
  }
  async remove(id: string) {
    return this.serialize(async () => {
      const db = await this.read();
      const size = db.entries.length;
      db.entries = db.entries.filter((entry) => entry.id !== id);
      if (db.entries.length === size) return false;
      await this.write(db);
      return true;
    });
  }
}
