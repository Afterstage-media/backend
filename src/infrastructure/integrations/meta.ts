import type { ContentItem, InstagramMetrics } from "../../domain/content/types.js";
import { MediaGateway } from "./media-gateway.js";

type MetaResult = {
  instagram?: string;
  facebook?: string;
  containerId?: string;
};

const graphUrl = (path: string) => {
  const version = process.env.META_API_VERSION ?? "v24.0";
  return `https://graph.facebook.com/${version}/${path.replace(/^\//, "")}`;
};

const graphPost = async (path: string, fields: Record<string, string>): Promise<Record<string, unknown>> => {
  const response = await fetch(graphUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
    signal: AbortSignal.timeout(60_000),
  });
  const result = (await response.json()) as Record<string, unknown>;
  if (!response.ok || result.error) {
    const error = result.error as { message?: string; code?: number } | undefined;
    throw new Error(`Meta Graph API ${error?.code ?? response.status}: ${error?.message ?? "error desconocido"}`);
  }
  return result;
};

const graphGet = async (path: string, token: string): Promise<Record<string, unknown>> => {
  const url = new URL(graphUrl(path));
  url.searchParams.set("access_token", token);
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  const result = (await response.json()) as Record<string, unknown>;
  if (!response.ok || result.error) throw new Error("No se pudo consultar el estado del contenedor de Instagram");
  return result;
};

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} no está configurada`);
  return value;
};

export class MetaPublisher {
  constructor(private readonly media = new MediaGateway()) {}

  async getInstagramMetrics(mediaId: string, dryRun = false): Promise<InstagramMetrics> {
    if (!mediaId) throw new Error("La publicación no tiene un ID remoto de Instagram");
    if (dryRun)
      return {
        likes: 0,
        comments: 0,
        saves: 0,
        shares: 0,
        reach: 0,
        impressions: 0,
        plays: 0,
        totalInteractions: 0,
        fetchedAt: new Date().toISOString(),
      };
    const token = requireEnv("META_ACCESS_TOKEN");
    const result = await graphGet(
      `${mediaId}/insights?metric=likes,comments,saved,shares,reach,impressions,plays,total_interactions`,
      token,
    );
    const values = (result.data as Array<{ name?: string; values?: Array<{ value?: number }> }> | undefined) ?? [];
    const metric = (name: string) => Number(values.find((entry) => entry.name === name)?.values?.[0]?.value ?? 0);
    return {
      likes: metric("likes"),
      comments: metric("comments"),
      saves: metric("saved"),
      shares: metric("shares"),
      reach: metric("reach"),
      impressions: metric("impressions"),
      plays: metric("plays"),
      totalInteractions: metric("total_interactions"),
      fetchedAt: new Date().toISOString(),
    };
  }

  async publish(
    item: ContentItem,
    dryRun = false,
    onContainerCreated?: (containerId: string) => Promise<void>,
  ): Promise<MetaResult> {
    if (item.channels.includes("instagram") && !item.assets.length) {
      throw new Error("Instagram requiere al menos una imagen con URL pública");
    }
    if (item.channels.includes("instagram") && item.type === "story" && item.assets.length !== 1) {
      throw new Error("Las Stories de Instagram requieren un único medio");
    }
    if (
      item.channels.includes("instagram") &&
      item.type === "reel" &&
      (item.assets.length !== 1 || item.assets[0]?.mediaType !== "video")
    ) {
      throw new Error("Los Reels de Instagram requieren un único video");
    }
    if (dryRun) {
      return Object.fromEntries(
        item.channels.filter((channel) => channel !== "website").map((channel) => [channel, `dry-run-${item.id}`]),
      );
    }

    const needsRemoteMedia = item.channels.includes("instagram") || item.channels.includes("facebook");
    const prepared = needsRemoteMedia ? await this.media.resolveAssets(item) : item;
    if (needsRemoteMedia) await this.media.validateAssets(prepared);

    const token = requireEnv("META_ACCESS_TOKEN");
    const result: MetaResult = {};
    if (prepared.channels.includes("instagram")) {
      const instagram = await this.publishInstagram(prepared, token, onContainerCreated);
      result.instagram = instagram.publishedId;
      result.containerId = instagram.containerId;
    }
    if (prepared.channels.includes("facebook")) result.facebook = await this.publishFacebook(prepared, token);
    return result;
  }

  private async publishInstagram(
    item: ContentItem,
    token: string,
    onContainerCreated?: (containerId: string) => Promise<void>,
  ): Promise<{ publishedId: string; containerId: string }> {
    const accountId = requireEnv("META_INSTAGRAM_ACCOUNT_ID");
    if (item.containerId) {
      await this.waitUntilReady(item.containerId, token);
      const publishedExisting = await graphPost(`${accountId}/media_publish`, {
        creation_id: item.containerId,
        access_token: token,
      });
      return {
        publishedId: String(publishedExisting.id),
        containerId: item.containerId,
      };
    }
    const assets = item.assets;
    if (!assets.length) throw new Error("Instagram requiere al menos un medio con URL pública");
    const videos = assets.filter((asset) => asset.mediaType === "video");
    const images = assets.filter((asset) => asset.mediaType !== "video").map((asset) => asset.url);

    let creationId: string;
    if (videos.length) {
      if (assets.length !== 1 || !videos[0]?.url)
        throw new Error("Los Reels y videos requieren un único archivo de video");
      const container = await graphPost(`${accountId}/media`, {
        media_type: item.type === "story" ? "STORIES" : "REELS",
        video_url: videos[0].url,
        caption: item.instagramCopy || item.summary || item.title,
        access_token: token,
      });
      creationId = String(container.id);
    } else if (images.length === 1) {
      const container = await graphPost(`${accountId}/media`, {
        image_url: images[0]!,
        ...(item.type === "story" ? { media_type: "STORIES" } : {}),
        caption: item.instagramCopy || item.summary || item.title,
        access_token: token,
      });
      creationId = String(container.id);
    } else {
      const children: string[] = [];
      for (const image of images.slice(0, 10)) {
        const child = await graphPost(`${accountId}/media`, {
          image_url: image,
          is_carousel_item: "true",
          access_token: token,
        });
        children.push(String(child.id));
      }
      const container = await graphPost(`${accountId}/media`, {
        media_type: "CAROUSEL",
        children: children.join(","),
        caption: item.instagramCopy || item.summary || item.title,
        access_token: token,
      });
      creationId = String(container.id);
    }

    if (onContainerCreated) await onContainerCreated(creationId);
    await this.waitUntilReady(creationId, token);
    const published = await graphPost(`${accountId}/media_publish`, {
      creation_id: creationId,
      access_token: token,
    });
    return { publishedId: String(published.id), containerId: creationId };
  }

  private async waitUntilReady(containerId: string, token: string): Promise<void> {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const state = await graphGet(`${containerId}?fields=status_code`, token);
      if (state.status_code === "FINISHED") return;
      if (state.status_code === "ERROR" || state.status_code === "EXPIRED") {
        throw new Error(`El contenedor de Instagram terminó en estado ${state.status_code}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    throw new Error("Instagram no terminó de procesar el contenido dentro del tiempo esperado");
  }

  private async publishFacebook(item: ContentItem, token: string): Promise<string> {
    const pageId = requireEnv("META_PAGE_ID");
    const message = item.facebookCopy || item.summary || item.title;
    const video = item.assets.find((asset) => asset.mediaType === "video");
    if (video) {
      if (item.assets.length !== 1 || !video.url) throw new Error("Facebook permite un único video por publicación");
      const result = await graphPost(`${pageId}/videos`, {
        file_url: video.url,
        description: message,
        title: item.title,
        access_token: token,
      });
      return String(result.id ?? result.post_id);
    }
    const result = item.assets[0]
      ? await graphPost(`${pageId}/photos`, {
          url: item.assets[0].url,
          caption: message,
          access_token: token,
        })
      : await graphPost(`${pageId}/feed`, { message, access_token: token });
    return String(result.post_id ?? result.id);
  }
}
