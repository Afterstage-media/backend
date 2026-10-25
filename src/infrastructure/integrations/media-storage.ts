import { randomUUID } from "node:crypto";
import type { ContentItem } from "../../domain/content/types.js";
import {
  MediaAssetNotFoundError,
  MongoMediaAssetStore,
  type MediaReservation,
  type MediaAssetRecord,
  type MediaObjectMetadata,
} from "../persistence/mongo-media-assets.js";

export const MEDIA_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type MediaContentType = (typeof MEDIA_CONTENT_TYPES)[number];

export type MediaUploadInput = {
  name: string;
  contentType: MediaContentType;
  size: number;
};

export type MediaUploadGrant = {
  assetId: string;
  uploadUrl: string;
  key: string;
  expiresAt: number;
};

export type MediaAssetResponse = {
  id: string;
  mediaAssetId: string;
  storage: "r2";
  key: string;
  url: string;
  mediaType: "image";
  altText: string;
  credit: string;
};

const extensionFor = (contentType: MediaContentType): string =>
  ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" })[contentType];

const monthKey = (date = new Date()): string => {
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${date.getUTCFullYear()}-${month}`;
};

const encodeKey = (key: string): string => key.split("/").map(encodeURIComponent).join("/");

export class MediaStorageUnavailableError extends Error {
  constructor() {
    super("El almacenamiento de medios R2 no está configurado");
    this.name = "MediaStorageUnavailableError";
  }
}

export class MediaGatewayClient {
  private readonly baseUrl = (process.env.MEDIA_GATEWAY_URL ?? "").replace(/\/$/, "");
  private readonly token = process.env.MEDIA_GATEWAY_SERVICE_TOKEN ?? "";
  private readonly publicBaseUrl = (process.env.MEDIA_PUBLIC_BASE_URL ?? "").replace(/\/$/, "");

  get configured(): boolean {
    return Boolean(this.baseUrl && this.token && this.publicBaseUrl);
  }

  private ensureConfigured() {
    if (!this.configured) throw new MediaStorageUnavailableError();
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    this.ensureConfigured();
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.token}`);
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    return fetch(`${this.baseUrl}${path}`, { ...init, headers, signal: AbortSignal.timeout(15_000) });
  }

  async createGrant(input: {
    key: string;
    contentType: MediaContentType;
    size: number;
    quota: {
      reservationId: string;
      totalBytesAfterReservation: number;
      monthlyBytesAfterReservation: number;
    };
  }): Promise<{ uploadUrl: string; key: string; expiresAt: number }> {
    const response = await this.request("/v1/upload-grants", {
      method: "POST",
      body: JSON.stringify(input),
    });
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) throw new Error(String(data.error ?? `El gateway rechazó el grant (${response.status})`));
    if (typeof data.uploadUrl !== "string" || typeof data.key !== "string" || typeof data.expiresAt !== "number") {
      throw new Error("El gateway devolvió un grant incompleto");
    }
    return { uploadUrl: data.uploadUrl, key: data.key, expiresAt: data.expiresAt };
  }

  async inspect(key: string): Promise<MediaObjectMetadata | null> {
    const response = await this.request(`/v1/media/${encodeKey(key)}`, { method: "HEAD" });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`No se pudo verificar el medio (${response.status})`);
    return {
      key,
      size: Number(response.headers.get("content-length") ?? 0),
      contentType: response.headers.get("content-type") ?? "",
      etag: response.headers.get("etag") ?? "",
    };
  }

  async remove(key: string): Promise<void> {
    const response = await this.request(`/v1/media/${encodeKey(key)}`, { method: "DELETE" });
    if (!response.ok && response.status !== 404) throw new Error(`No se pudo eliminar el medio (${response.status})`);
  }

  async list(prefix: string, cursor?: string): Promise<{ objects: MediaObjectMetadata[]; cursor: string | null }> {
    const response = await this.request("/v1/reconciliation/objects", {
      method: "POST",
      body: JSON.stringify({ prefix, cursor, limit: 1000 }),
    });
    const data = (await response.json().catch(() => ({}))) as {
      objects?: MediaObjectMetadata[];
      cursor?: string | null;
    };
    if (!response.ok || !Array.isArray(data.objects)) throw new Error(`No se pudo listar R2 (${response.status})`);
    return { objects: data.objects, cursor: data.cursor ?? null };
  }

  publicUrl(key: string): string {
    this.ensureConfigured();
    return `${this.publicBaseUrl}/media/${encodeKey(key)}`;
  }
}

export class MediaAssetService {
  constructor(
    private readonly store: MongoMediaAssetStore,
    private readonly gateway = new MediaGatewayClient(),
  ) {}

  get configured(): boolean {
    return this.gateway.configured;
  }

  async createUploadGrants(contentId: string, files: MediaUploadInput[]): Promise<MediaUploadGrant[]> {
    if (!this.configured) throw new MediaStorageUnavailableError();
    const grants: MediaUploadGrant[] = [];
    for (const file of files) {
      const assetId = randomUUID();
      const key = `public/${monthKey()}/${contentId}/${assetId}.${extensionFor(file.contentType)}`;
      let reservation: MediaReservation;
      try {
        reservation = await this.store.reserveUpload({
          id: assetId,
          requestedContentId: contentId,
          key,
          contentType: file.contentType,
          sizeBytes: file.size,
        });
        const grant = await this.gateway.createGrant({
          key,
          contentType: file.contentType,
          size: file.size,
          quota: {
            reservationId: reservation.reservationId,
            totalBytesAfterReservation: reservation.totalBytesAfterReservation,
            monthlyBytesAfterReservation: reservation.monthlyBytesAfterReservation,
          },
        });
        grants.push({ assetId, ...grant });
      } catch (error) {
        await this.store.cancelReservation(assetId).catch(() => undefined);
        throw error;
      }
    }
    return grants;
  }

  async completeUpload(assetId: string): Promise<MediaAssetResponse> {
    const asset = await this.store.get(assetId);
    if (!asset || asset.status === "deleted") throw new MediaAssetNotFoundError(assetId);
    const object = await this.gateway.inspect(asset.key);
    if (!object) throw new Error("La foto todavía no está disponible en R2");
    if (object.size !== asset.sizeBytes || object.contentType !== asset.contentType) {
      await this.gateway.remove(asset.key).catch(() => undefined);
      await this.store.cancelReservation(assetId);
      throw new Error("El objeto subido no coincide con la reserva");
    }
    const uploaded = await this.store.markUploaded(assetId);
    return this.toResponse(uploaded);
  }

  async syncContentAssets(contentId: string, assets: ContentItem["assets"]): Promise<void> {
    const ids = assets
      .filter((asset) => asset.storage === "r2")
      .map((asset) => asset.mediaAssetId || asset.id)
      .filter(Boolean);
    await this.store.syncContentAssets(contentId, ids);
  }

  async removeAsset(assetId: string): Promise<void> {
    const asset = await this.store.get(assetId);
    if (!asset || asset.status === "deleted") return;
    if (this.configured) await this.gateway.remove(asset.key);
    await this.store.markDeleted(assetId);
  }

  async cleanup(now = new Date()): Promise<number> {
    if (!this.configured) return 0;
    const candidates = await this.store.cleanupCandidates(now);
    let removed = 0;
    for (const asset of candidates) {
      try {
        await this.gateway.remove(asset.key);
        await this.store.markDeleted(asset._id);
        removed += 1;
      } catch (error) {
        await this.store.recordError(asset._id, error instanceof Error ? error.message : String(error));
      }
    }
    return removed;
  }

  async reconcile(now = new Date()): Promise<{ scanned: number; orphaned: number; missing: number }> {
    if (!this.configured) return { scanned: 0, orphaned: 0, missing: 0 };
    const seen = new Set<string>();
    let cursor: string | undefined;
    let scanned = 0;
    let orphaned = 0;
    do {
      const page = await this.gateway.list("public/", cursor);
      for (const object of page.objects) {
        seen.add(object.key);
        scanned += 1;
        const known = await this.store.getByKey(object.key);
        if (!known) {
          await this.store.recordOrphan(object, now);
          orphaned += 1;
        }
      }
      cursor = page.cursor ?? undefined;
    } while (cursor);
    const missing = await this.store.markMissing(seen, now);
    return { scanned, orphaned, missing };
  }

  private toResponse(asset: MediaAssetRecord): MediaAssetResponse {
    return {
      id: asset._id,
      mediaAssetId: asset._id,
      storage: "r2",
      key: asset.key,
      url: this.gateway.publicUrl(asset.key),
      mediaType: "image",
      altText: "",
      credit: "",
    };
  }
}
