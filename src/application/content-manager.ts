import { createHash } from "node:crypto";
import { AiWriter, type GenerationKind } from "../infrastructure/integrations/ai.js";
import { MetaPublisher } from "../infrastructure/integrations/meta.js";
import { ContentStore, type ContentRepository } from "../infrastructure/persistence/content-store.js";
import {
  contentInputSchema,
  agentNoteInputSchema,
  imageInputSchema,
  type AgentNoteInput,
  type ContentInput,
  type ContentItem,
  type ContentPatch,
  type ContentStatus,
  slugify,
} from "../domain/content/types.js";
import { parsePatch } from "../domain/parse-patch.js";
import { assertTransition } from "../domain/content/workflow.js";
import { detectDuplicates, type DuplicateMatch } from "../domain/content/duplicate-detector.js";
import { MediaAssetStore } from "../infrastructure/persistence/media-assets.js";
import { InstagramCarouselRenderer } from "../infrastructure/integrations/instagram-carousel-renderer.js";
import {
  correctedCarouselImageSchema,
  instagramCarouselInputSchema,
  type InstagramCarouselInput,
} from "../domain/content/social-carousel.js";
import type { SocialTemplate } from "../domain/content/social-template.js";
import { MediaAssetService } from "../infrastructure/integrations/media-storage.js";

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
    private readonly media = new MediaAssetStore(),
    private readonly carouselRenderer = new InstagramCarouselRenderer(),
    private readonly mediaStorage?: MediaAssetService,
  ) {}

  private async persistCarouselImages(
    contentId: string,
    images: Awaited<ReturnType<InstagramCarouselRenderer["render"]>>,
  ) {
    if (this.mediaStorage?.configured) {
      const grants = await this.mediaStorage.createUploadGrants(
        contentId,
        images.map((image, index) => ({
          name: `afterstage-carrusel-${index + 1}.png`,
          contentType: "image/png",
          size: image.buffer.length,
        })),
      );
      const assets: ContentItem["assets"] = [];
      try {
        for (const [index, grant] of grants.entries()) {
          const uploaded = await fetch(grant.uploadUrl, {
            method: "PUT",
            headers: { "Content-Type": "image/png" },
            body: new Uint8Array(images[index]!.buffer),
            signal: AbortSignal.timeout(20_000),
          });
          if (!uploaded.ok) throw new Error("No se pudo guardar una lámina en el almacenamiento de medios");
          assets.push({
            ...(await this.mediaStorage.completeUpload(grant.assetId)),
            localPath: "",
            altText: images[index]!.altText,
            credit: images[index]!.credit,
          });
        }
        return assets;
      } catch (error) {
        await Promise.all(grants.map((grant) => this.mediaStorage!.removeAsset(grant.assetId).catch(() => undefined)));
        throw error;
      }
    }

    return this.media.createImages(
      images.map((image, index) => ({
        base64: image.buffer.toString("base64"),
        mimeType: "image/png" as const,
        filename: `afterstage-carrusel-${index + 1}.png`,
        altText: image.altText,
        credit: image.credit,
      })),
    );
  }

  async create(input: unknown): Promise<ContentItem> {
    const parsed = contentInputSchema.parse(input);
    if (!["idea", "draft"].includes(parsed.status)) {
      throw new Error("El contenido nuevo debe comenzar como idea o borrador");
    }
    if (parsed.idempotencyKey) {
      const existing = await this.store.findByIdempotencyKey(parsed.idempotencyKey);
      if (existing) return existing;
    }
    const duplicates = detectDuplicates(parsed, await this.store.list(), undefined, 0.82);
    if (duplicates.length) {
      if (parsed.idempotencyKey) {
        const existing = await this.store.findByIdempotencyKey(parsed.idempotencyKey);
        if (existing) return existing;
      }
      throw new DuplicateContentError(duplicates);
    }
    return this.store.create(parsed);
  }

  async createAgentNote(input: unknown, idempotencyScope = "global"): Promise<ContentItem> {
    const parsed = agentNoteInputSchema.parse(input) as AgentNoteInput;
    const idempotencyKey = parsed.idempotencyKey ? `${idempotencyScope}:${parsed.idempotencyKey}` : undefined;
    if (idempotencyKey) {
      const existing = await this.store.findByIdempotencyKey(idempotencyKey);
      if (existing) return existing;
    }
    const assets = await this.media.createImages(parsed.images);
    try {
      const created = await this.create({
        type: "article",
        title: parsed.title,
        summary: parsed.summary,
        body: parsed.body,
        instagramCopy: parsed.instagramCopy,
        facebookCopy: parsed.facebookCopy,
        status: "draft",
        channels: parsed.channels,
        tags: parsed.tags,
        source: parsed.source,
        assets,
        idempotencyKey,
      });
      const storedAssetIds = new Set(created.assets.map((asset) => asset.id));
      if (assets.some((asset) => !storedAssetIds.has(asset.id))) await this.media.remove(assets);
      return created;
    } catch (error) {
      await this.media.remove(assets);
      throw error;
    }
  }

  async addImages(id: string, input: unknown): Promise<ContentItem> {
    const current = await this.required(id);
    const images = imageInputSchema.array().min(1).max(10).parse(input);
    const assets = await this.media.createImages(images);
    try {
      const updated = await this.store.update(id, { assets: [...current.assets, ...assets] });
      if (!updated) throw new Error("Contenido no encontrado");
      return updated;
    } catch (error) {
      await this.media.remove(assets);
      throw error;
    }
  }

  async createInstagramCarousel(input: unknown, actorId: string, template: SocialTemplate): Promise<ContentItem> {
    const parsed = instagramCarouselInputSchema.parse(input) as InstagramCarouselInput;
    if (parsed.templateId !== template.id)
      throw new Error("La plantilla seleccionada no coincide con el identificador enviado");
    if (
      template.status !== "published" ||
      template.outputType !== "carousel" ||
      !template.channels.includes("instagram")
    ) {
      throw new Error("La plantilla no está publicada para carruseles de Instagram");
    }

    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          templateId: template.id,
          title: parsed.title,
          instagramCopy: parsed.instagramCopy,
          slides: parsed.slides.map((slide) => ({
            image: createHash("sha256").update(slide.image.base64).digest("hex"),
            text: slide.text,
          })),
        }),
      )
      .digest("hex");
    const idempotencyKey = `instagram-carousel:${actorId}:${fingerprint}`;
    const existing = await this.store.findByIdempotencyKey(idempotencyKey);
    if (existing) return existing;

    const rendered = await this.carouselRenderer.render(template, parsed.title, parsed.slides);
    const shell = await this.store.create(
      contentInputSchema.parse({
        type: "carousel",
        title: parsed.title,
        slug: `instagram-${slugify(parsed.title).slice(0, 185)}-${fingerprint.slice(0, 8)}`,
        summary: parsed.slides[0]!.text,
        body: parsed.slides.map((slide, index) => `Lámina ${index + 1}: ${slide.text}`).join("\n\n"),
        status: "draft",
        channels: ["instagram"],
        assets: [],
        instagramCopy: parsed.instagramCopy,
        tags: parsed.tags,
        source: parsed.source,
        author: parsed.author,
        photographer: parsed.photographer,
        socialTemplateId: template.id,
        socialTemplateVersion: template.templateVersion,
        socialRenderedAt: null,
        idempotencyKey,
      }),
    );
    if (shell.assets.length) return shell;

    let assets: ContentItem["assets"] = [];
    try {
      assets = await this.persistCarouselImages(shell.id, rendered);
      const updated = await this.store.update(shell.id, {
        assets,
        socialRenderedAt: new Date().toISOString(),
      });
      if (!updated) throw new Error("No se pudo completar el borrador del carrusel");
      if (this.mediaStorage?.configured) await this.mediaStorage.syncContentAssets(shell.id, updated.assets);
      return updated;
    } catch (error) {
      if (this.mediaStorage?.configured) await this.mediaStorage.syncContentAssets(shell.id, []).catch(() => undefined);
      else await this.media.remove(assets);
      await this.store.remove(shell.id);
      throw error;
    }
  }

  async replaceInstagramCarouselImage(
    publicationId: string,
    slideNumber: number,
    input: unknown,
    template: SocialTemplate,
  ): Promise<ContentItem> {
    const parsed = correctedCarouselImageSchema.parse(input);
    const item = await this.required(publicationId);
    if (item.type !== "carousel" || !item.channels.includes("instagram") || item.status !== "draft") {
      throw new Error("Solo se pueden corregir láminas de un borrador de Instagram");
    }
    if (item.socialTemplateId !== template.id) throw new Error("La plantilla no coincide con el carrusel");
    const index = slideNumber - 1;
    const previous = item.assets[index];
    if (!Number.isInteger(slideNumber) || !previous || previous.mediaType !== "image") {
      throw new Error("El número de lámina no existe en este carrusel");
    }
    const correctionImage = {
      ...parsed.image,
      altText: parsed.image.altText?.trim() || previous.altText,
      credit: parsed.image.credit || previous.credit,
    };
    const buffer = await this.carouselRenderer.normalizeCorrection(template, correctionImage);
    const replacement = await this.persistCarouselImages(publicationId, [
      { buffer, altText: correctionImage.altText, credit: correctionImage.credit },
    ]);
    try {
      const assets = [...item.assets];
      assets[index] = replacement[0]!;
      const updated = await this.store.update(publicationId, {
        assets,
        socialRenderedAt: new Date().toISOString(),
      });
      if (!updated) throw new Error("No se pudo reemplazar la lámina");
      if (this.mediaStorage?.configured) await this.mediaStorage.syncContentAssets(publicationId, updated.assets);
      else await this.media.remove([previous]);
      return updated;
    } catch (error) {
      await this.store.update(publicationId, { assets: item.assets }).catch(() => undefined);
      if (this.mediaStorage?.configured)
        await this.mediaStorage.syncContentAssets(publicationId, item.assets).catch(() => undefined);
      else await this.media.remove(replacement);
      throw error;
    }
  }

  /** Compatibility name for existing HTTP callers; generation happens in the agent, not here. */
  async createNoteWithAi(input: unknown, idempotencyScope = "global"): Promise<ContentItem> {
    return this.createAgentNote(input, idempotencyScope);
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

  async repostInstagram(id: string, dryRun = false): Promise<ContentItem> {
    const current = await this.required(id);
    if (current.status !== "published") throw new Error("Solo se puede recompartir una nota publicada");
    if (!current.channels.includes("instagram")) throw new Error("La nota no tiene Instagram entre sus canales");
    if (!current.assets.length) throw new Error("Instagram requiere al menos una imagen con URL pública");

    const instagramItem: ContentItem = {
      ...current,
      channels: ["instagram"],
      containerId: null,
      remoteIds: {},
      publishedMediaId: null,
    };
    if (dryRun) {
      await this.publisher.publish(instagramItem, true);
      return current;
    }

    const remote = await this.publisher.publish(instagramItem, false);
    const updated = await this.store.update(id, {
      remoteIds: {
        ...current.remoteIds,
        ...(remote.instagram ? { instagram: remote.instagram } : {}),
      },
      containerId: remote.containerId ?? null,
      publishedMediaId: remote.instagram ?? current.publishedMediaId,
      lastError: null,
    });
    if (!updated) throw new Error("Contenido no encontrado luego de recompartir en Instagram");
    return updated;
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
