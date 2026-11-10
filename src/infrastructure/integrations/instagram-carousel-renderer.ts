import sharp from "sharp";
import type { CarouselImageInput, CarouselSlideInput } from "../../domain/content/social-carousel.js";
import type { SocialTemplate } from "../../domain/content/social-template.js";

export type RenderedCarouselImage = {
  buffer: Buffer;
  altText: string;
  credit: string;
};

const xml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!,
  );

const wrap = (value: string, limit: number, maxLines: number) => {
  const lines: string[] = [];
  let line = "";
  const words = value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((word) => (word.length > limit ? (word.match(new RegExp(`.{1,${limit}}`, "g")) ?? [word]) : [word]));
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > limit && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  return [...lines.slice(0, maxLines - 1), `${lines[maxLines - 1]!.slice(0, limit - 1)}…`];
};

const svgLines = (
  value: string,
  x: number,
  y: number,
  fontSize: number,
  lineHeight: number,
  fill: string,
  limit: number,
  maxLines: number,
  weight = 700,
  fontFamily = "DM Sans",
) =>
  wrap(value, limit, maxLines)
    .map(
      (line, index) =>
        `<text x="${x}" y="${y + index * lineHeight}" font-family="${xml(fontFamily)}" font-size="${fontSize}" font-weight="${weight}" fill="${fill}">${xml(line)}</text>`,
    )
    .join("");

const parseImage = (input: CarouselImageInput) => {
  const value = input.base64.trim();
  const dataUrl = value.match(/^data:([^;,]+);base64,(.*)$/is);
  const encoded = (dataUrl?.[2] ?? value).replace(/\s/g, "");
  const dataUrlMime = dataUrl?.[1]?.toLowerCase();
  const mimeType = (input.mimeType ?? dataUrlMime ?? "image/jpeg").toLowerCase();
  if (!["image/jpeg", "image/png", "image/webp"].includes(mimeType)) {
    throw new Error("Las láminas aceptan fotos JPG, PNG o WebP");
  }
  if (dataUrlMime && input.mimeType && dataUrlMime !== input.mimeType.toLowerCase()) {
    throw new Error("El tipo MIME declarado no coincide con el data URL de la foto");
  }
  if (!encoded || !/^[a-z\d+/]*={0,2}$/i.test(encoded) || encoded.length % 4 === 1) {
    throw new Error("Una de las imágenes no contiene base64 válido");
  }
  const bytes = Buffer.from(encoded, "base64");
  const canonical = bytes.toString("base64").replace(/=+$/, "");
  if (!bytes.length || canonical !== encoded.replace(/=+$/, "")) {
    throw new Error("Una de las imágenes no contiene base64 válido");
  }
  if (bytes.length > 2.5 * 1024 * 1024) throw new Error("Cada foto debe pesar menos de 2,5 MiB para usarla en MCP");
  return { bytes, mimeType };
};

export class InstagramCarouselRenderer {
  async render(
    template: SocialTemplate,
    title: string,
    slides: CarouselSlideInput[],
  ): Promise<RenderedCarouselImage[]> {
    if (!["carousel", "post", "story"].includes(template.outputType) || !template.channels.includes("instagram")) {
      throw new Error("Elegí una plantilla publicada para Instagram");
    }
    if (template.outputType === "carousel" && (slides.length < 2 || slides.length > 9)) {
      throw new Error("El carrusel debe tener entre 2 y 9 láminas");
    }
    if (template.outputType === "post" && slides.length !== 1) {
      throw new Error("Una publicación simple debe tener una lámina");
    }
    if (template.outputType === "story" && slides.length !== 1) {
      throw new Error("Una historia de Instagram debe tener una lámina");
    }

    const { width, height } = template.canvas;
    const guidance = template.slides[0]!;
    const visual = template.visualStyle;
    const { background: ink, foreground: paper, accent, overlay } = visual.palette;
    const displayFont = "Oswald";
    const bodyFont = "DM Sans";
    const rendered: RenderedCarouselImage[] = [];
    for (const [index, slide] of slides.entries()) {
      const original = parseImage(slide.image);
      const source = sharp(original.bytes, { failOn: "error", limitInputPixels: 40_000_000 });
      const metadata = await source.metadata();
      if (!metadata.width || !metadata.height || !["jpeg", "png", "webp"].includes(metadata.format ?? "")) {
        throw new Error(`La imagen de la lámina ${index + 1} no es un JPG, PNG o WebP válido`);
      }
      const actualMime = metadata.format === "jpeg" ? "image/jpeg" : `image/${metadata.format}`;
      if (actualMime !== original.mimeType)
        throw new Error(`El tipo MIME de la lámina ${index + 1} no coincide con la imagen`);
      const scale = width / 1080;
      const x = Math.round(68 * scale);
      const cover = index === 0;
      const coverTitle = cover && template.outputType !== "story";
      const footerY = height - Math.round(66 * scale);
      const footer = `<text x="${x}" y="${footerY}" font-family="${displayFont}" font-size="${Math.round(27 * scale)}" font-weight="700" letter-spacing="1.5" fill="${paper}">AFTERSTAGE</text><rect x="${x + Math.round(168 * scale)}" y="${footerY - Math.round(20 * scale)}" width="${Math.round(12 * scale)}" height="${Math.round(12 * scale)}" fill="${accent}"/><text x="${width - x}" y="${footerY}" text-anchor="end" font-family="${bodyFont}" font-size="${Math.round(23 * scale)}" font-weight="700" fill="${paper}">${String(index + 1).padStart(2, "0")}/${String(slides.length).padStart(2, "0")}</text>`;
      const eyebrow = cover ? visual.coverEyebrow : guidance.eyebrow || "AFTERSTAGE";
      let imageLayer = "";
      let content = "";
      let decoration = "";

      if (visual.layout === "photo-overlay") {
        const background = await source
          .resize(width, height, { fit: "cover", position: "attention" })
          .jpeg({ quality: 88 })
          .toBuffer();
        imageLayer = `<image href="data:image/jpeg;base64,${background.toString("base64")}" x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="xMidYMid slice"/>`;
        decoration = `<defs><linearGradient id="shade" x1="0" y1="0" x2="0" y2="1"><stop offset="28%" stop-color="${overlay}" stop-opacity="0"/><stop offset="100%" stop-color="${overlay}" stop-opacity="0.84"/></linearGradient></defs><rect width="${width}" height="${height}" fill="url(#shade)"/>`;
        content = coverTitle
          ? `<text x="${x}" y="${Math.round(height * 0.57)}" font-family="${bodyFont}" font-size="${Math.round(27 * scale)}" font-weight="700" letter-spacing="5" fill="${paper}">${xml(eyebrow)}</text><path d="M${x} ${Math.round(height * 0.6)}h${Math.round(125 * scale)}" stroke="${accent}" stroke-width="${Math.round(12 * scale)}"/>${svgLines(title.toUpperCase(), x, Math.round(height * 0.7), Math.round(98 * scale), Math.round(102 * scale), paper, Math.max(12, Math.round(20 / scale)), 2, 700, displayFont)}${svgLines(slide.text, x, Math.round(height * 0.86), Math.round(34 * scale), Math.round(42 * scale), paper, Math.max(24, Math.round(44 / scale)), 2, 700, bodyFont)}`
          : `<rect x="0" y="${Math.round(height * 0.63)}" width="${width}" height="${Math.round(height * 0.37)}" fill="${ink}" opacity="0.72"/><path d="M${x} ${Math.round(height * 0.69)}h${Math.round(96 * scale)}" stroke="${accent}" stroke-width="${Math.round(10 * scale)}"/>${svgLines(slide.text, x, Math.round(height * 0.76), Math.round(39 * scale), Math.round(53 * scale), paper, Math.max(24, Math.round(46 / scale)), 4, 700, bodyFont)}`;
      } else if (visual.layout === "split-panel") {
        const photoHeight = Math.round(height * 0.59);
        const photo = await source
          .resize(width, photoHeight, { fit: "cover", position: "attention" })
          .jpeg({ quality: 88 })
          .toBuffer();
        imageLayer = `<rect width="${width}" height="${height}" fill="${ink}"/><image href="data:image/jpeg;base64,${photo.toString("base64")}" x="0" y="0" width="${width}" height="${photoHeight}" preserveAspectRatio="xMidYMid slice"/>`;
        decoration = `<rect x="0" y="${photoHeight}" width="${width}" height="${height - photoHeight}" fill="${ink}"/>`;
        const kickerY = photoHeight + Math.round(76 * scale);
        content = `<text x="${x}" y="${kickerY}" font-family="${bodyFont}" font-size="${Math.round(24 * scale)}" font-weight="700" letter-spacing="4" fill="${accent}">${xml(eyebrow)}</text><path d="M${x} ${kickerY + Math.round(24 * scale)}h${Math.round(105 * scale)}" stroke="${accent}" stroke-width="${Math.round(8 * scale)}"/>${svgLines(coverTitle ? title.toUpperCase() : slide.text, x, kickerY + Math.round(112 * scale), Math.round(72 * scale), Math.round(78 * scale), paper, Math.max(15, Math.round(24 / scale)), 2, 700, displayFont)}${coverTitle ? svgLines(slide.text, x, height - Math.round(118 * scale), Math.round(25 * scale), Math.round(31 * scale), paper, Math.max(30, Math.round(55 / scale)), 2, 400, bodyFont) : ""}`;
      } else {
        const footerHeight = Math.round(88 * scale);
        const tall = height / width > 1.5;
        const photoY = Math.round(height * (tall ? 0.68 : 0.68));
        const photoHeight = height - footerHeight - photoY;
        const photo = await source
          .resize(width, photoHeight, { fit: "cover", position: "attention" })
          .jpeg({ quality: 88 })
          .toBuffer();
        const headline = coverTitle ? title.toUpperCase() : slide.text;
        const kickerY = Math.round(height * 0.18);
        const headlineY = Math.round(height * (tall ? 0.31 : 0.32));
        const headlineSize = Math.round(width * (headline.length > 60 ? 0.064 : headline.length > 36 ? 0.072 : 0.084));
        const headlineLimit = Math.max(13, Math.round((width / headlineSize) * 1.72));
        const headlineLines = tall ? 5 : 3;
        const bodyY = Math.round(height * (tall ? 0.53 : 0.55));
        const posterFooter = `<rect x="0" y="${height - footerHeight}" width="${width}" height="${footerHeight}" fill="${ink}"/><path d="M${x} ${height - footerHeight + Math.round(24 * scale)}h${Math.round(94 * scale)}" stroke="${accent}" stroke-width="${Math.round(7 * scale)}"/><text x="${x}" y="${height - Math.round(25 * scale)}" font-family="${displayFont}" font-size="${Math.round(25 * scale)}" font-weight="700" letter-spacing="2" fill="${paper}">AFTERSTAGE</text><text x="${width - x}" y="${height - Math.round(25 * scale)}" text-anchor="end" font-family="${bodyFont}" font-size="${Math.round(20 * scale)}" font-weight="700" fill="${paper}">${String(index + 1).padStart(2, "0")} / ${String(slides.length).padStart(2, "0")}</text>`;
        imageLayer = `<rect width="${width}" height="${height}" fill="${ink}"/><image href="data:image/jpeg;base64,${photo.toString("base64")}" x="0" y="${photoY}" width="${width}" height="${photoHeight}" preserveAspectRatio="xMidYMid slice"/>`;
        decoration = `<defs><pattern id="print-dots" width="12" height="12" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.15" fill="${accent}" opacity="0.26"/></pattern></defs><rect x="0" y="0" width="${width}" height="${photoY}" fill="${ink}"/><rect x="${Math.round(width * 0.74)}" y="${Math.round(height * 0.12)}" width="${Math.round(width * 0.2)}" height="${Math.round(height * 0.28)}" fill="url(#print-dots)"/><text x="${width - x}" y="${Math.round(height * 0.31)}" text-anchor="end" font-family="${displayFont}" font-size="${Math.round(width * 0.31)}" font-weight="700" fill="${accent}" opacity="0.08">${String(index + 1).padStart(2, "0")}</text><path d="M${x} ${Math.round(height * 0.115)}h${Math.round(118 * scale)}" stroke="${accent}" stroke-width="${Math.round(12 * scale)}"/><text x="${x}" y="${kickerY}" font-family="${bodyFont}" font-size="${Math.round(22 * scale)}" font-weight="700" letter-spacing="4" fill="${accent}">${xml(eyebrow)}</text><path d="M${x} ${Math.round(height * 0.23)}h${Math.round(width - 2 * x)}" stroke="${paper}" stroke-opacity="0.22" stroke-width="2"/>`;
        content = `${svgLines(headline, x, headlineY, headlineSize, Math.round(headlineSize * 1.02), paper, headlineLimit, headlineLines, 700, displayFont)}${coverTitle ? svgLines(slide.text, x, bodyY, Math.round(width * 0.032), Math.round(width * 0.043), paper, Math.max(26, Math.round(width * 0.052)), 3, 500, bodyFont) : ""}${posterFooter}`;
      }

      const corner = `<path d="M${width - x} ${x}h-${Math.round(62 * scale)}M${width - x} ${x}v${Math.round(62 * scale)}" fill="none" stroke="${accent}" stroke-width="${Math.round(9 * scale)}"/>`;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${imageLayer}${decoration}${content}${visual.layout === "photo-overlay" ? corner : ""}${visual.layout === "type-poster" ? "" : footer}</svg>`;
      rendered.push({
        buffer: await sharp(Buffer.from(svg)).png().toBuffer(),
        altText: slide.image.altText || `${title} — lámina ${index + 1}`,
        credit: slide.image.credit,
      });
    }
    return rendered;
  }

  async normalizeCorrection(template: SocialTemplate, image: CarouselImageInput): Promise<Buffer> {
    const { bytes, mimeType } = parseImage(image);
    const source = sharp(bytes, { failOn: "error", limitInputPixels: 40_000_000 });
    const metadata = await source.metadata();
    if (!metadata.width || !metadata.height) throw new Error("La imagen corregida no tiene dimensiones válidas");
    const actualMime = metadata.format === "jpeg" ? "image/jpeg" : `image/${metadata.format}`;
    if (actualMime !== mimeType) throw new Error("El tipo MIME de la imagen corregida no coincide con la imagen");
    const ratio = metadata.width / metadata.height;
    const targetRatio = template.canvas.width / template.canvas.height;
    if (Math.abs(ratio - targetRatio) > 0.01) {
      throw new Error(
        `La imagen corregida debe conservar la proporción ${template.canvas.width}:${template.canvas.height}`,
      );
    }
    return source.resize(template.canvas.width, template.canvas.height, { fit: "cover" }).png().toBuffer();
  }
}
