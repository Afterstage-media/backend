import { createHash } from "node:crypto";
import path from "node:path";
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
  instagramCarouselUpdateSchema,
  type CarouselImageInput,
  type InstagramCarouselInput,
  type InstagramCarouselUpdate,
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

  private async persistCarouselSources(
    contentId: string,
    slides: readonly { image: CarouselImageInput; text: string }[],
  ): Promise<NonNullable<ContentItem["socialSlides"]>> {
    if (!slides.length) return [];
    const originals = slides.map(({ image }) => {
      const raw = image.base64.trim();
      const dataUrl = raw.match(/^data:([^;,]+);base64,(.*)$/is);
      const base64 = (dataUrl?.[2] ?? raw).replace(/\s/g, "");
      const mimeType = image.mimeType ?? dataUrl?.[1] ?? "image/jpeg";
      return {
        base64,
        mimeType: mimeType as "image/jpeg" | "image/png" | "image/webp",
        filename: image.filename,
        altText: image.altText,
        credit: image.credit,
      };
    });
    let sources: ContentItem["assets"];
    if (this.mediaStorage?.configured) {
      const grants = await this.mediaStorage.createUploadGrants(
        contentId,
        originals.map((image, index) => ({
          name: image.filename || `fuente-carrusel-${index + 1}.${image.mimeType.split("/")[1]}`,
          contentType: image.mimeType,
          size: Buffer.from(image.base64, "base64").length,
        })),
      );
      sources = [];
      try {
        for (const [index, grant] of grants.entries()) {
          const image = originals[index]!;
          const response = await fetch(grant.uploadUrl, {
            method: "PUT",
            headers: { "Content-Type": image.mimeType },
            body: new Uint8Array(Buffer.from(image.base64, "base64")),
            signal: AbortSignal.timeout(20_000),
          });
          if (!response.ok) throw new Error("No se pudo guardar una imagen fuente del carrusel");
          sources.push({
            ...(await this.mediaStorage.completeUpload(grant.assetId)),
            localPath: "",
            altText: image.altText,
            credit: image.credit,
          });
        }
      } catch (error) {
        await Promise.all(grants.map((grant) => this.mediaStorage!.removeAsset(grant.assetId).catch(() => undefined)));
        throw error;
      }
    } else {
      sources = await this.media.createImages(originals);
    }
    return slides.map((slide, index) => ({ text: slide.text, source: sources[index]! }));
  }

  private async readCarouselSource(source: ContentItem["assets"][number]): Promise<CarouselImageInput> {
    const mediaBase =
      process.env.MEDIA_PUBLIC_BASE_URL ??
      process.env.PUBLIC_MEDIA_BASE_URL ??
      process.env.PUBLIC_BASE_URL ??
      process.env.CLOUDFLARE_TUNNEL_URL;
    if (!mediaBase) throw new Error("No se pudo localizar la imagen fuente del carrusel");
    const expectedOrigin = new URL(mediaBase).origin;
    const sourceUrl = new URL(source.url);
    if (sourceUrl.origin !== expectedOrigin)
      throw new Error("La imagen fuente no pertenece al almacenamiento de Afterstage");
    const response = await fetch(sourceUrl, { redirect: "error", signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error("No se pudo recuperar una imagen fuente del borrador");
    const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
    if (!(mimeType === "image/jpeg" || mimeType === "image/png" || mimeType === "image/webp")) {
      throw new Error("El tipo de una imagen fuente guardada no es compatible");
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 2.5 * 1024 * 1024)
      throw new Error("Una imagen fuente del borrador supera 2,5 MiB");
    return {
      base64: bytes.toString("base64"),
      mimeType,
      filename: path.basename(sourceUrl.pathname),
      altText: source.altText,
      credit: source.credit,
    };
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
    let socialSlides: NonNullable<ContentItem["socialSlides"]> = [];
    try {
      socialSlides = await this.persistCarouselSources(shell.id, parsed.slides);
      assets = await this.persistCarouselImages(shell.id, rendered);
      const updated = await this.store.update(shell.id, {
        assets,
        socialSlides,
        socialRenderedAt: new Date().toISOString(),
      });
      if (!updated) throw new Error("No se pudo completar el borrador del carrusel");
      if (this.mediaStorage?.configured) {
        await this.mediaStorage.syncContentAssets(shell.id, [
          ...updated.assets,
          ...(updated.socialSlides ?? []).map((slide) => slide.source),
        ]);
      }
      return updated;
    } catch (error) {
      if (this.mediaStorage?.configured) await this.mediaStorage.syncContentAssets(shell.id, []).catch(() => undefined);
      else await this.media.remove([...assets, ...socialSlides.map((slide) => slide.source)]);
      await this.store.remove(shell.id);
      throw error;
    }
  }

  async updateInstagramCarousel(publicationId: string, input: unknown, template: SocialTemplate): Promise<ContentItem> {
    const parsed = instagramCarouselUpdateSchema.parse(input) as InstagramCarouselUpdate;
    if (parsed.templateId !== template.id)
      throw new Error("La plantilla seleccionada no coincide con el identificador enviado");
    if (
      template.status !== "published" ||
      template.outputType !== "carousel" ||
      !template.channels.includes("instagram")
    ) {
      throw new Error("La plantilla no está publicada para carruseles de Instagram");
    }
    const item = await this.required(publicationId);
    if (item.type !== "carousel" || !item.channels.includes("instagram") || item.status !== "draft") {
      throw new Error("Solo se pueden editar carruseles de Instagram que sigan en borrador");
    }
    const oldSlides = item.socialSlides ?? [];
    const legacySources = oldSlides.length !== item.assets.length;
    const templateChanged = item.socialTemplateId !== template.id;
    if (legacySources && parsed.slides.some((slide) => !slide.image)) {
      throw new Error(
        "Este borrador anterior no conserva las fotos originales. Volvé a cargar una imagen en cada lámina para editarlo.",
      );
    }
    const previousIndices = parsed.slides.map((slide, index) => {
      if (!slide.sourceAssetId) return index;
      const previousIndex = oldSlides.findIndex((current) => current.source.id === slide.sourceAssetId);
      if (previousIndex < 0)
        throw new Error("Una lámina ya no pertenece a este borrador. Actualizá la pantalla e intentá de nuevo.");
      return previousIndex;
    });
    if (!legacySources && parsed.slides.some((slide, index) => !slide.image && !oldSlides[previousIndices[index]!])) {
      throw new Error("Cargá una imagen en cada lámina nueva.");
    }

    const changedSlides = new Set<number>();
    if (templateChanged) parsed.slides.forEach((_, index) => changedSlides.add(index));
    if (parsed.title !== item.title) changedSlides.add(0);
    parsed.slides.forEach((slide, index) => {
      const previousIndex = previousIndices[index]!;
      if (
        slide.image ||
        slide.text !== oldSlides[previousIndex]?.text ||
        previousIndex !== index ||
        (legacySources && !oldSlides.length)
      ) {
        changedSlides.add(index);
      }
    });

    const sourceInputs = changedSlides.size
      ? await Promise.all(
          parsed.slides.map(async (slide, index) => {
            if (slide.image) return slide.image;
            const source = oldSlides[previousIndices[index]!]?.source;
            if (!source) throw new Error(`Cargá una imagen para la lámina ${index + 1}.`);
            return this.readCarouselSource(source);
          }),
        )
      : [];
    const renderSlides = changedSlides.size
      ? parsed.slides.map((slide, index) => ({ image: sourceInputs[index]!, text: slide.text }))
      : [];

    let newSources: ContentItem["assets"] = [];
    let newRendered: ContentItem["assets"] = [];
    let committed = false;
    try {
      const sourceSlides = parsed.slides
        .map((slide, index) => (slide.image ? { index, image: slide.image, text: slide.text } : null))
        .filter((slide): slide is { index: number; image: CarouselImageInput; text: string } => Boolean(slide));
      if (sourceSlides.length) {
        const persisted = await this.persistCarouselSources(
          publicationId,
          sourceSlides.map(({ image, text }) => ({ image, text })),
        );
        newSources = persisted.map((slide) => slide.source);
      }

      const rendered = changedSlides.size
        ? await this.carouselRenderer.render(template, parsed.title, renderSlides)
        : [];
      if (changedSlides.size) {
        const changedIndices = [...changedSlides].sort((left, right) => left - right);
        newRendered = await this.persistCarouselImages(
          publicationId,
          changedIndices.map((index) => rendered[index]!),
        );
      }

      const nextSourceAssets = [...parsed.slides].map((slide, index) => {
        if (slide.image) {
          const newSourceIndex = sourceSlides.findIndex((sourceSlide) => sourceSlide.index === index);
          const source = newSources[newSourceIndex];
          if (!source) throw new Error(`No se pudo guardar la imagen de la lámina ${index + 1}`);
          return { text: slide.text, source };
        }
        return { text: slide.text, source: oldSlides[previousIndices[index]!]!.source };
      });
      const renderedAssetByIndex = new Map<number, ContentItem["assets"][number]>();
      [...changedSlides]
        .sort((left, right) => left - right)
        .forEach((slideIndex, renderedIndex) => {
          renderedAssetByIndex.set(slideIndex, newRendered[renderedIndex]!);
        });
      const nextAssets = parsed.slides.map(
        (_, index) => renderedAssetByIndex.get(index) ?? item.assets[previousIndices[index]!]!,
      );
      const updated = await this.store.update(publicationId, {
        title: parsed.title,
        summary: parsed.slides[0]!.text,
        body: parsed.slides.map((slide, index) => `Lámina ${index + 1}: ${slide.text}`).join("\n\n"),
        instagramCopy: parsed.instagramCopy,
        tags: parsed.tags,
        source: parsed.source,
        author: parsed.author,
        photographer: parsed.photographer,
        socialTemplateId: template.id,
        socialTemplateVersion: template.templateVersion,
        assets: nextAssets,
        socialSlides: nextSourceAssets,
        socialRenderedAt: changedSlides.size ? new Date().toISOString() : item.socialRenderedAt,
      });
      if (!updated) throw new Error("No se pudo guardar el carrusel");
      committed = true;
      if (this.mediaStorage?.configured) {
        await this.mediaStorage.syncContentAssets(publicationId, [
          ...updated.assets,
          ...(updated.socialSlides ?? []).map((slide) => slide.source),
        ]);
      } else {
        const retained = new Set([
          ...updated.assets.map((asset) => asset.id),
          ...(updated.socialSlides ?? []).map((slide) => slide.source.id),
        ]);
        await this.media.remove(
          [...item.assets, ...oldSlides.map((slide) => slide.source)].filter((asset) => !retained.has(asset.id)),
        );
      }
      return updated;
    } catch (error) {
      if (committed) throw error;
      if (this.mediaStorage?.configured) {
        await Promise.all(
          [...newSources, ...newRendered].map((asset) =>
            this.mediaStorage!.removeAsset(asset.mediaAssetId || asset.id).catch(() => undefined),
          ),
        );
      } else {
        await this.media.remove([...newSources, ...newRendered]);
      }
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
      if (this.mediaStorage?.configured)
        await this.mediaStorage.syncContentAssets(publicationId, [
          ...updated.assets,
          ...(updated.socialSlides ?? []).map((slide) => slide.source),
        ]);
      else await this.media.remove([previous]);
      return updated;
    } catch (error) {
      await this.store.update(publicationId, { assets: item.assets }).catch(() => undefined);
      if (this.mediaStorage?.configured)
        await this.mediaStorage
          .syncContentAssets(publicationId, [...item.assets, ...(item.socialSlides ?? []).map((slide) => slide.source)])
          .catch(() => undefined);
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

  async discardDraft(id: string): Promise<boolean> {
    const item = await this.required(id);
    if (item.status !== "draft" && item.status !== "idea") {
      throw new Error("Solo se pueden descartar borradores o ideas");
    }
    const removed = await this.store.remove(id);
    if (!removed) return false;
    if (this.mediaStorage?.configured) {
      await this.mediaStorage.syncContentAssets(id, []);
    } else {
      await this.media.remove([...item.assets, ...(item.socialSlides ?? []).map((slide) => slide.source)]);
    }
    return true;
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
