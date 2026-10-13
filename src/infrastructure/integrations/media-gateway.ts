import { access, stat } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import path from "node:path";
import type { ContentItem } from "../../domain/content/types.js";

type MediaAsset = ContentItem["assets"][number];

const privateIpv4 = (value: string) => {
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const first = parts[0]!;
  const second = parts[1]!;
  return (
    first === 10 ||
    first === 127 ||
    first === 0 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
};

const privateAddress = (value: string) => {
  const normalized = value.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(normalized) === 4) return privateIpv4(normalized);
  if (isIP(normalized) === 6)
    return (
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe80") ||
      normalized.startsWith("::ffff:127.")
    );
  return false;
};

export const assertPublicUrl = async (value: string, resolver: typeof lookup = lookup) => {
  const parsed = new URL(value);
  if (!/^https?:$/i.test(parsed.protocol)) throw new Error("La URL de medios debe usar HTTP o HTTPS");
  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    privateAddress(hostname)
  )
    throw new Error("La URL de medios apunta a una red privada");
  const addresses = await resolver(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((entry) => privateAddress(entry.address)))
    throw new Error("La URL de medios no resuelve a una red pública");
};

/** Resolves local media through a public Cloudflare Tunnel URL only while Meta processes it. */
export class MediaGateway {
  constructor(
    private readonly root = path.resolve(process.env.MEDIA_ROOT ?? process.env.UPLOAD_DIR ?? "uploads"),
    private readonly resolver: typeof lookup = lookup,
  ) {}

  private localFile(localPath: string): { absolute: string; relative: string } {
    const absolute = path.resolve(path.isAbsolute(localPath) ? localPath : path.join(this.root, localPath));
    const rootPrefix = `${this.root}${path.sep}`;
    if (absolute !== this.root && !absolute.startsWith(rootPrefix))
      throw new Error("La ruta de medios queda fuera de MEDIA_ROOT");
    return {
      absolute,
      relative: path.relative(this.root, absolute).split(path.sep).join("/"),
    };
  }

  async resolve(asset: MediaAsset): Promise<string> {
    if (!asset.localPath) {
      if (!asset.url) throw new Error("El recurso no tiene URL pública ni ruta local");
      return asset.url;
    }
    const file = this.localFile(asset.localPath);
    await access(file.absolute);
    const base = process.env.CLOUDFLARE_TUNNEL_URL ?? process.env.PUBLIC_MEDIA_BASE_URL ?? process.env.PUBLIC_BASE_URL;
    if (!base)
      throw new Error("Falta CLOUDFLARE_TUNNEL_URL o PUBLIC_MEDIA_BASE_URL para exponer medios locales a Meta");
    return `${base.replace(/\/$/, "")}/media/${file.relative.split("/").map(encodeURIComponent).join("/")}`;
  }

  async resolveAssets(item: ContentItem): Promise<ContentItem> {
    const assets = await Promise.all(
      item.assets.map(async (asset) => ({
        ...asset,
        url: await this.resolve(asset),
      })),
    );
    return { ...item, assets };
  }

  async validatePublicUrl(url: string, mediaType: "image" | "video"): Promise<void> {
    await assertPublicUrl(url, this.resolver);
    const response = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`La URL pública de medios respondió HTTP ${response.status}`);
    const contentType = response.headers.get("content-type")?.split(";")[0]?.toLowerCase() ?? "";
    const valid = mediaType === "video" ? contentType.startsWith("video/") : contentType.startsWith("image/");
    if (!valid) throw new Error(`La URL pública devolvió Content-Type ${contentType || "vacío"}, no un ${mediaType}`);
  }

  async validateAssets(item: ContentItem): Promise<void> {
    for (const asset of item.assets)
      await this.validatePublicUrl(
        asset.url,
        asset.mediaType ?? (asset.url.match(/\.(mp4|mov|webm)(\?|$)/i) ? "video" : "image"),
      );
  }

  async localMediaExists(localPath: string): Promise<boolean> {
    try {
      return (await stat(this.localFile(localPath).absolute)).isFile();
    } catch {
      return false;
    }
  }
}
