import { AiWriter, type GenerationKind } from "../infrastructure/integrations/ai.js";
import { MetaPublisher } from "../infrastructure/integrations/meta.js";
import { ContentStore, type ContentRepository } from "../infrastructure/persistence/content-store.js";
import {
  contentInputSchema,
  type ContentInput,
  type ContentItem,
  type ContentPatch,
  type ContentStatus,
} from "../domain/content/types.js";
import { parsePatch } from "../domain/parse-patch.js";
import { assertTransition } from "../domain/content/workflow.js";
import { detectDuplicates, type DuplicateMatch } from "../domain/content/duplicate-detector.js";

export class DuplicateContentError extends Error {
  constructor(readonly matches: DuplicateMatch[]) {
    super(`Contenido duplicado detectado: ${matches.map((match) => match.item.id).join(", ")}`);
    this.name = "DuplicateContentError";
  }
}

export class ContentManager {
  constructor(
    readonly store: ContentRepository = new ContentStore(),
    private readonly ai = new AiWriter(),
    private readonly publisher = new MetaPublisher(),
  ) {}

  async create(input: unknown): Promise<ContentItem> {
    const parsed = contentInputSchema.parse(input);
    if (!["idea", "draft"].includes(parsed.status)) {
      throw new Error("El contenido nuevo debe comenzar como idea o borrador");
    }
    const duplicates = detectDuplicates(parsed, await this.store.list(), undefined, 0.82);
    if (duplicates.length) throw new DuplicateContentError(duplicates);
    return this.store.create(parsed);
  }

  async findDuplicates(input: unknown, excludeId?: string): Promise<DuplicateMatch[]> {
    const parsed = contentInputSchema.parse(input);
    return detectDuplicates(parsed, await this.store.list(), excludeId);
  }

  async update(id: string, input: unknown): Promise<ContentItem> {
    const current = await this.required(id);
    const patch = parsePatch(contentInputSchema, input);
    if (patch.title || patch.slug || patch.summary || patch.body || patch.source) {
      const duplicates = detectDuplicates({ ...current, ...patch }, await this.store.list(), id, 0.82);
      if (duplicates.length) throw new DuplicateContentError(duplicates);
    }
    if (patch.status) {
      if (patch.status !== current.status && ["publishing", "published", "failed"].includes(patch.status)) {
        throw new Error("Ese estado es administrado internamente por el publicador");
      }
      assertTransition(current.status, patch.status);
    }
    const resultingStatus = patch.status ?? current.status;
    const resultingSchedule = patch.scheduledAt === undefined ? current.scheduledAt : patch.scheduledAt;
    if (resultingStatus === "scheduled" && !resultingSchedule) {
      throw new Error("El contenido programado necesita fecha y hora");
    }
    const updated = await this.store.update(id, patch);
    if (!updated) throw new Error("Contenido no encontrado");
    return updated;
  }

  async generate(id: string, kind: GenerationKind, extraInstructions = ""): Promise<ContentItem> {
    const current = await this.required(id);
    const all = await this.store.list();
    const terms = `${current.title} ${current.summary} ${current.tags.join(" ")}`
      .toLowerCase()
      .split(/\s+/)
      .filter((term) => term.length > 2);
    const context = all
      .filter((candidate) => candidate.id !== id)
      .map((candidate) => ({
        candidate,
        score: terms.reduce(
          (score, term) =>
            score +
            (`${candidate.title} ${candidate.summary} ${candidate.tags.join(" ")}`.toLowerCase().includes(term)
              ? 1
              : 0),
          0,
        ),
      }))
      .sort((a, b) => b.score - a.score || b.candidate.updatedAt.localeCompare(a.candidate.updatedAt))
      .slice(0, 5)
      .map(({ candidate }) => candidate);
    const generated = await this.ai.generate(current, kind, extraInstructions, context);
    const allowed: ContentPatch = {
      title: generated.title,
      summary: generated.summary,
      body: generated.body,
      instagramCopy: generated.instagramCopy,
      facebookCopy: generated.facebookCopy,
      tags: generated.tags,
    };
    Object.keys(allowed).forEach(
      (key) => allowed[key as keyof ContentPatch] === undefined && delete allowed[key as keyof ContentPatch],
    );
    const updated = await this.store.update(id, allowed);
    if (!updated) throw new Error("Contenido no encontrado");
    return updated;
  }

  async search(query: string, status?: ContentStatus): Promise<ContentItem[]> {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return this.store.list(status);
    const terms = normalized.split(/\s+/).filter(Boolean);
    return (await this.store.list(status)).filter((item) => {
      const haystack =
        `${item.title} ${item.summary} ${item.body} ${item.tags.join(" ")} ${item.source} ${item.author}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }

  async publish(id: string, dryRun = false): Promise<ContentItem> {
    const current = await this.required(id);
    if (!["approved", "scheduled", "failed"].includes(current.status)) {
      throw new Error("Solo se puede publicar contenido aprobado, programado o fallido");
    }
    if (!current.channels.length) throw new Error("Seleccioná al menos un canal antes de publicar");
    if (dryRun) {
      await this.publisher.publish(current, true);
      return current;
    }
    const claimed = await this.store.claimForPublishing(id);
    if (!claimed) throw new Error("La publicación ya está en proceso o no se puede reclamar");
    try {
      const remote = await this.publisher.publish(claimed, dryRun, async (containerId) => {
        await this.store.update(id, { containerId, lastError: null });
      });
      const remoteIds = Object.fromEntries(
        Object.entries(remote).filter(([key]) => key === "instagram" || key === "facebook"),
      ) as ContentItem["remoteIds"];
      const attempts = (claimed.attempts ?? 0) + 1;
      const updated = await this.store.update(id, {
        status: "published",
        remoteIds: {
          ...claimed.remoteIds,
          ...remoteIds,
          ...(claimed.channels.includes("website") ? { website: claimed.slug } : {}),
        },
        publishedAt: new Date().toISOString(),
        attempts,
        nextAttemptAt: null,
        publishedMediaId: remote.instagram ?? remote.facebook ?? null,
        lastError: null,
      });
      if (!updated) throw new Error("Contenido no encontrado luego de publicar");
      return updated;
    } catch (error) {
      const attempts = (claimed.attempts ?? 0) + 1;
      const message = (error as Error).message;
      const retryable =
        !/(token|permiso|permission|formato|content-type|no existe|fuera de MEDIA_ROOT)/i.test(message) && attempts < 5;
      const retryAt = retryable
        ? new Date(Date.now() + [30, 120, 300, 900][Math.min(attempts - 1, 3)]! * 1000).toISOString()
        : null;
      await this.store.update(id, {
        status: retryable ? "scheduled" : "failed",
        scheduledAt: retryAt,
        nextAttemptAt: retryAt,
        attempts,
        lastError: message,
      });
      throw error;
    }
  }

  async refreshInstagramMetrics(id: string, dryRun = false): Promise<ContentItem> {
    const current = await this.required(id);
    const mediaId = current.remoteIds.instagram;
    if (!mediaId) throw new Error("El contenido todavía no tiene una publicación de Instagram");
    const metrics = await this.publisher.getInstagramMetrics(mediaId, dryRun);
    const updated = await this.store.update(id, { instagramMetrics: metrics });
    if (!updated) throw new Error("Contenido no encontrado");
    return updated;
  }

  async instagramMetrics() {
    const contents = await this.store.list();
    const posts = contents.filter((item) => item.remoteIds.instagram && item.instagramMetrics);
    const sum = (key: keyof Omit<NonNullable<ContentItem["instagramMetrics"]>, "fetchedAt">) =>
      posts.reduce((total, item) => total + (item.instagramMetrics?.[key] ?? 0), 0);
    return {
      posts: posts.length,
      totals: {
        likes: sum("likes"),
        comments: sum("comments"),
        saves: sum("saves"),
        shares: sum("shares"),
        reach: sum("reach"),
        impressions: sum("impressions"),
        plays: sum("plays"),
        totalInteractions: sum("totalInteractions"),
      },
      updatedAt:
        posts
          .map((item) => item.instagramMetrics!.fetchedAt)
          .sort()
          .at(-1) ?? null,
      items: posts.map((item) => ({
        id: item.id,
        title: item.title,
        publishedAt: item.publishedAt,
        mediaId: item.remoteIds.instagram,
        metrics: item.instagramMetrics,
      })),
    };
  }

  async publishDue(): Promise<void> {
    const now = Date.now();
    const due = (await this.store.list()).filter(
      (item) =>
        ["scheduled", "failed"].includes(item.status) &&
        (item.nextAttemptAt ?? item.scheduledAt) &&
        Date.parse(item.nextAttemptAt ?? item.scheduledAt!) <= now,
    );
    for (const item of due) {
      try {
        await this.publish(item.id);
      } catch (error) {
        console.error(`No se pudo publicar ${item.id}:`, (error as Error).message);
      }
    }
  }

  async required(id: string): Promise<ContentItem> {
    const item = await this.store.get(id);
    if (!item) throw new Error("Contenido no encontrado");
    return item;
  }
}

export type { ContentInput };
