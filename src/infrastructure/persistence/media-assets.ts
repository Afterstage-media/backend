import { mkdir, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ContentItem, ImageInput } from "../../domain/content/types.js";

type MediaAsset = ContentItem["assets"][number];

const maxImageBytes = 20 * 1024 * 1024;
const extensionByMime = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
} as const;

const publicBase = () => {
  const base = process.env.CLOUDFLARE_TUNNEL_URL ?? process.env.PUBLIC_MEDIA_BASE_URL ?? process.env.PUBLIC_BASE_URL;
  if (!base) throw new Error("Falta una URL pública para exponer los medios del MCP");
  return base.replace(/\/$/, "");
};

const mediaRoot = () => path.resolve(process.env.MEDIA_ROOT ?? process.env.UPLOAD_DIR ?? "uploads");

const parseBase64 = (input: ImageInput): { bytes: Buffer; mimeType: keyof typeof extensionByMime } => {
  const value = input.base64.trim();
  const dataUrl = value.match(/^data:([^;,]+);base64,(.*)$/is);
  const encoded = (dataUrl?.[2] ?? value).replace(/\s/g, "");
  const dataUrlMime = dataUrl?.[1]?.toLowerCase();
  const mimeType = (input.mimeType ?? dataUrlMime ?? "image/jpeg").toLowerCase();

  if (!(mimeType in extensionByMime)) throw new Error(`Tipo de imagen no permitido: ${mimeType}`);
  if (dataUrlMime && input.mimeType && dataUrlMime !== input.mimeType.toLowerCase()) {
    throw new Error("El tipo MIME declarado no coincide con el data URL");
  }
  if (!encoded || !/^[a-z\d+/]*={0,2}$/i.test(encoded) || encoded.length % 4 === 1) {
    throw new Error("La imagen no contiene un base64 válido");
  }

  const bytes = Buffer.from(encoded, "base64");
  const canonical = bytes.toString("base64").replace(/=+$/, "");
  if (!bytes.length || canonical !== encoded.replace(/=+$/, ""))
    throw new Error("La imagen no contiene un base64 válido");
  if (bytes.length > maxImageBytes) throw new Error("La imagen supera el máximo de 20 MB");

  const signatureMatches =
    (mimeType === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
    (mimeType === "image/png" && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) ||
    (mimeType === "image/webp" &&
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP") ||
    (mimeType === "image/gif" && /^(GIF87a|GIF89a)$/.test(bytes.subarray(0, 6).toString("ascii")));
  if (!signatureMatches) throw new Error("El contenido de la imagen no coincide con su tipo MIME");

  return { bytes, mimeType: mimeType as keyof typeof extensionByMime };
};

export class MediaAssetStore {
  constructor(
    private readonly root = mediaRoot(),
    private readonly baseUrl?: string,
  ) {}

  async createImages(inputs: readonly ImageInput[]): Promise<MediaAsset[]> {
    if (!inputs.length) return [];
    await mkdir(this.root, { recursive: true });
    const created: MediaAsset[] = [];
    try {
      for (const input of inputs) {
        const { bytes, mimeType } = parseBase64(input);
        const filename = `${randomUUID()}${extensionByMime[mimeType]}`;
        await writeFile(path.join(this.root, filename), bytes, { flag: "wx" });
        created.push({
          id: randomUUID(),
          url: `${this.baseUrl ?? publicBase()}/media/${encodeURIComponent(filename)}`,
          localPath: filename,
          mediaType: "image",
          altText: input.altText,
          credit: input.credit,
        });
      }
      return created;
    } catch (error) {
      await this.remove(created);
      throw error;
    }
  }

  async remove(assets: readonly MediaAsset[]): Promise<void> {
    await Promise.all(
      assets.map(async (asset) => {
        if (!asset.localPath) return;
        const absolute = path.resolve(this.root, asset.localPath);
        const prefix = `${this.root}${path.sep}`;
        if (!absolute.startsWith(prefix)) return;
        await unlink(absolute).catch(() => undefined);
      }),
    );
  }
}
