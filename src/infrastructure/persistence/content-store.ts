import { mkdir, readFile, rename, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  type ContentInput,
  type ContentItem,
  type ContentPatch,
  type ContentStatus,
  type Database,
  slugify,
} from "../../domain/content/types.js";

export interface ContentRepository {
  list(status?: ContentStatus): Promise<ContentItem[]>;
  get(id: string): Promise<ContentItem | undefined>;
  create(input: ContentInput): Promise<ContentItem>;
  update(
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
  ): Promise<ContentItem | undefined>;
  remove(id: string): Promise<boolean>;
  claimForPublishing(id: string): Promise<ContentItem | undefined>;
  incrementViews(id: string): Promise<ContentItem | undefined>;
}

export class ContentStore implements ContentRepository {
  private readonly file: string;
  private readonly lock: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir = process.env.DATA_DIR ?? path.resolve("data")) {
    this.file = path.join(dataDir, "content.json");
    this.lock = path.join(dataDir, ".content.lock");
  }

  private async read(): Promise<Database> {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as Partial<Database>;
      return {
        contents: (parsed.contents ?? []).map((item) => ({
          ...item,
          attempts: item.attempts ?? 0,
          nextAttemptAt: item.nextAttemptAt ?? null,
          containerId: item.containerId ?? null,
          publishedMediaId: item.publishedMediaId ?? null,
          viewCount: item.viewCount ?? 0,
          instagramMetrics: item.instagramMetrics ?? null,
        })),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { contents: [] };
    }
  }

  private async write(database: Database): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(database, null, 2)}\n`, "utf8");
    await rename(temp, this.file);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const locked = () => this.withFileLock(operation);
    const next = this.queue.then(locked, locked);
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
        const lockAge = Date.now() - lockInfo.mtimeMs;
        if (lockAge > 30_000) await rmdir(this.lock).catch(() => undefined);
        if (Date.now() >= deadline) throw new Error("No se pudo obtener el bloqueo de escritura del contenido");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      return await operation();
    } finally {
      await rmdir(this.lock).catch(() => undefined);
    }
  }

  async list(status?: ContentStatus): Promise<ContentItem[]> {
    const { contents } = await this.read();
    return contents
      .filter((item) => !status || item.status === status)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<ContentItem | undefined> {
    return (await this.read()).contents.find((item) => item.id === id);
  }

  async create(input: ContentInput): Promise<ContentItem> {
    return this.serialize(async () => {
      const database = await this.read();
      const now = new Date().toISOString();
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
      database.contents.push(item);
      await this.write(database);
      return item;
    });
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
          | "instagramMetrics"
        >
      >,
  ): Promise<ContentItem | undefined> {
    return this.serialize(async () => {
      const database = await this.read();
      const index = database.contents.findIndex((item) => item.id === id);
      if (index < 0) return undefined;
      const current = database.contents[index]!;
      const updated: ContentItem = {
        ...current,
        ...patch,
        id: current.id,
        slug: patch.slug || (patch.title ? slugify(patch.title) : current.slug),
        updatedAt: new Date().toISOString(),
      };
      database.contents[index] = updated;
      await this.write(database);
      return updated;
    });
  }

  async remove(id: string): Promise<boolean> {
    return this.serialize(async () => {
      const database = await this.read();
      const count = database.contents.length;
      database.contents = database.contents.filter((item) => item.id !== id);
      if (database.contents.length === count) return false;
      await this.write(database);
      return true;
    });
  }

  async claimForPublishing(id: string): Promise<ContentItem | undefined> {
    return this.serialize(async () => {
      const database = await this.read();
      const index = database.contents.findIndex(
        (item) => item.id === id && ["approved", "scheduled", "failed"].includes(item.status),
      );
      if (index < 0) return undefined;
      const current = database.contents[index]!;
      const updated = {
        ...current,
        status: "publishing" as const,
        attempts: current.attempts ?? 0,
        updatedAt: new Date().toISOString(),
      };
      database.contents[index] = updated;
      await this.write(database);
      return updated;
    });
  }

  async incrementViews(id: string): Promise<ContentItem | undefined> {
    return this.serialize(async () => {
      const database = await this.read();
      const item = database.contents.find((entry) => entry.id === id);
      if (!item) return undefined;
      item.viewCount = (item.viewCount ?? 0) + 1;
      item.updatedAt = new Date().toISOString();
      await this.write(database);
      return item;
    });
  }
}
