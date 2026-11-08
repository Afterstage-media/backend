import sharp from "sharp";
import type { ContentItem } from "../../domain/content/types.js";
import type { SocialTemplate } from "../../domain/content/social-template.js";

const xml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!,
  );
const wrap = (value: string, limit: number, maxLines: number) => {
  const words = value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((word) => (word.length > limit ? (word.match(new RegExp(`.{1,${limit}}`, "g")) ?? [word]) : [word]));
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > limit && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  return [...lines.slice(0, maxLines - 1), `${lines[maxLines - 1]!.slice(0, Math.max(0, limit - 1))}…`];
};
const svgText = (
  value: string,
  x: number,
  y: number,
  fontSize: number,
  lineHeight: number,
  fill: string,
  weight = 700,
  limit = 24,
  lines = 5,
) =>
  wrap(value, limit, lines)
    .map(
      (line, index) =>
        `<text x="${x}" y="${y + index * lineHeight}" font-family="Arial,sans-serif" font-size="${fontSize}" font-weight="${weight}" fill="${fill}">${xml(line)}</text>`,
    )
    .join("");
const readBounded = async (response: Response, maxBytes: number) => {
  if (!response.body) throw new Error("La foto adjunta no devolvió contenido");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("La foto supera el límite de 8 MiB para generar la plantilla");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
};

export type RenderedTemplateAsset = { buffer: Buffer; altText: string; credit: string };

export class SocialTemplateRenderer {
  async render(template: SocialTemplate, item: ContentItem, data: Record<string, string>) {
    const assets: RenderedTemplateAsset[] = [];
    const photos = item.assets.filter(
      (asset) => asset.mediaType === "image" && !asset.altText.startsWith("[Plantilla:"),
    );
    for (const [index, slide] of template.slides.entries()) {
      const title = String(data[slide.titleField] ?? "").trim();
      const body = slide.bodyField ? String(data[slide.bodyField] ?? "").trim() : "";
      const photo = photos.length ? photos[index % photos.length] : undefined;
      let imageLayer = "";
      if (photo?.url) {
        const allowedBases = [process.env.MEDIA_PUBLIC_BASE_URL, process.env.PUBLIC_BASE_URL]
          .filter(Boolean)
          .map((value) => String(value).replace(/\/$/, ""));
        const allowed = allowedBases.some((base) => photo.url.startsWith(`${base}/`));
        if (!allowed)
          throw new Error(
            "La foto debe estar cargada en el almacenamiento público de Afterstage para usarla en una plantilla",
          );
        const response = await fetch(photo.url, { signal: AbortSignal.timeout(5000), redirect: "error" });
        const contentType = response.headers.get("content-type") ?? "";
        const declaredLength = Number(response.headers.get("content-length") ?? 0);
        if (
          !response.ok ||
          !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(contentType.split(";")[0]!.toLowerCase())
        )
          throw new Error("No se pudo leer la foto adjunta para generar la plantilla");
        if (declaredLength > 8 * 1024 * 1024)
          throw new Error("La foto supera el límite de 8 MiB para generar la plantilla");
        const bytes = await readBounded(response, 8 * 1024 * 1024);
        const normalized = await sharp(bytes)
          .resize(template.canvas.width, template.canvas.height, { fit: "cover" })
          .jpeg()
          .toBuffer();
        imageLayer = `<image href="data:image/jpeg;base64,${normalized.toString("base64")}" x="0" y="0" width="${template.canvas.width}" height="${template.canvas.height}" preserveAspectRatio="xMidYMid slice"/><rect width="100%" height="100%" fill="#111111" opacity="0.56"/>`;
      }
      const { width, height } = template.canvas;
      const titleFont = title.length > 52 ? 62 : title.length > 30 ? 76 : 94;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="${slide.background}"/>${imageLayer}<rect x="54" y="54" width="${width - 108}" height="${height - 108}" fill="none" stroke="${slide.accent}" stroke-width="8"/><path d="M80 170h150" stroke="${slide.accent}" stroke-width="18"/><text x="80" y="240" font-family="Arial,sans-serif" font-size="32" font-weight="700" letter-spacing="5" fill="${imageLayer ? "#ffffff" : "#171717"}">${xml(slide.eyebrow || "AFTERSTAGE")}</text>${svgText(title || item.title, 80, 390, titleFont, titleFont + 16, imageLayer ? "#ffffff" : "#171717", 900, 22, 5)}${svgText(body, 80, Math.round(height * 0.72), 36, 48, imageLayer ? "#ffffff" : "#353535", 500, 46, 4)}<text x="80" y="${height - 92}" font-family="Arial,sans-serif" font-size="28" font-weight="700" letter-spacing="3" fill="${imageLayer ? "#ffffff" : "#171717"}">AFTERSTAGE  ·  ${String(index + 1).padStart(2, "0")}/${String(template.slides.length).padStart(2, "0")}</text></svg>`;
      const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
      assets.push({ buffer, altText: `${item.title} — diapositiva ${index + 1}`, credit: item.photographer || "" });
    }
    return assets;
  }
}
