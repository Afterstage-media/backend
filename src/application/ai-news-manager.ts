import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  sourceInputSchema,
  type AiAnalysis,
  type AiCopy,
  type NewsSource,
  type ScrapedItem,
} from "../domain/ai-news/types.js";
import { aiAnalysisSchema, aiCopySchema } from "../domain/ai-news/types.js";
import { GeminiClient } from "../infrastructure/integrations/gemini.js";

export const aiNewsEditorialGuidance = [
  "Escribí para un medio argentino de música, en español rioplatense natural: cercano, claro y periodístico, sin voz de comunicado ni lunfardo forzado.",
  "Para la nota web: título específico, primer párrafo con el hecho y su atribución, y después contexto útil en párrafos cortos. No rellenes si la fuente ofrece pocos datos.",
  "Para Instagram: abrí con el dato concreto que le importa a una persona que sigue música; sumá contexto breve y, si está verificado, un dato práctico local que alguien quiera guardar o compartir. El copy debe complementar la imagen, no repetirla palabra por palabra.",
  "Usá un tono cálido sin hype ni clickbait. No agregues preguntas genéricas, pedidos de compartir, promesas, adjetivos grandilocuentes ni emojis de compromiso. Una pregunta solo si abre una conversación genuina sobre la noticia; como máximo un emoji y solo si suma.",
  "Las historias forman una secuencia breve: una idea por placa, con avance claro desde la noticia hacia el dato útil. Hashtags: entre 3 y 5, específicos y pertinentes.",
  "No inventes ni infieras información. Que la fuente no mencione un dato no significa que ese dato no esté confirmado. Conservá atribución, fecha, lugares y husos horarios; solo incluí conversiones locales cuando se provean como verificadas.",
].join(" ");

export interface AiNewsStore {
  listSources(): Promise<NewsSource[]>;
  saveSource(source: NewsSource): Promise<void>;
  removeSource(id: string): Promise<boolean>;
  listItems(topic?: string, limit?: number): Promise<ScrapedItem[]>;
  saveItems(items: ScrapedItem[]): Promise<void>;
}

const privateIpv4 = (ip: string) => {
  const octets = ip.split(".").map(Number);
  return (
    octets[0] === 10 ||
    octets[0] === 127 ||
    octets[0] === 0 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 100 && (octets[1] ?? 0) >= 64 && (octets[1] ?? 0) <= 127) ||
    (octets[0] ?? 0) >= 224
  );
};
async function assertPublicUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443"))
    throw new Error("La fuente debe usar HTTPS público y no incluir credenciales ni puertos alternativos");
  const addresses = isIP(url.hostname) ? [{ address: url.hostname }] : await lookup(url.hostname, { all: true });
  if (
    !addresses.length ||
    addresses.some(({ address }) =>
      isIP(address) === 4
        ? privateIpv4(address)
        : address === "::1" || address.startsWith("fc") || address.startsWith("fd") || address.startsWith("fe80:"),
    )
  )
    throw new Error("La URL resuelve a una dirección no pública");
  return;
}
const capture = (html: string, pattern: string) => {
  try {
    const match = new RegExp(pattern, "i").exec(html);
    return (match?.[1] ?? "")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    throw new Error("Una expresión regular de la fuente no es válida");
  }
};
async function readHtml(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) throw new Error("La fuente no devolvió contenido");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new Error("La página supera el límite de descarga permitido (1,5 MB)");
    }
    chunks.push(value);
  }
  const buffer = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(buffer);
}

export class AiNewsManager {
  constructor(
    private readonly store: AiNewsStore,
    private readonly gemini = new GeminiClient(),
  ) {}
  listSources() {
    return this.store.listSources();
  }
  async saveSource(input: unknown) {
    const parsed = sourceInputSchema.parse(input);
    await assertPublicUrl(parsed.url);
    const existing = (await this.store.listSources()).find(
      (source) => source.url === parsed.url && source.name === parsed.name,
    );
    const now = new Date().toISOString();
    const source: NewsSource = {
      ...parsed,
      id: existing?.id ?? randomUUID(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.store.saveSource(source);
    return source;
  }
  removeSource(id: string) {
    return this.store.removeSource(id);
  }
  listItems(topic?: string, limit = 100) {
    return this.store.listItems(topic, Math.min(Math.max(limit, 1), 200));
  }
  async scrape(sourceId?: string) {
    const sources = (await this.store.listSources()).filter(
      (item) => item.enabled && (!sourceId || item.id === sourceId),
    );
    const items: ScrapedItem[] = [];
    for (const source of sources) {
      await assertPublicUrl(source.url);
      const response = await fetch(source.url, {
        headers: {
          "User-Agent": "AfterstageNewsBot/1.0 (+https://afterstage.ar)",
          Accept: "text/html,application/xhtml+xml",
        },
        redirect: "error",
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) throw new Error(`No se pudo leer ${source.name}: HTTP ${response.status}`);
      const type = response.headers.get("content-type") ?? "";
      if (!type.includes("text/html") && !type.includes("application/xhtml+xml"))
        throw new Error(`La fuente ${source.name} no respondió HTML`);
      const html = await readHtml(response, 1_500_000);
      const chunks = html.match(new RegExp(source.itemPattern, "gis")) ?? [];
      for (const chunk of chunks.slice(0, source.maxItems)) {
        const title = capture(chunk, source.titlePattern);
        const rawLink = capture(chunk, source.linkPattern);
        if (!title) continue;
        const url = new URL(rawLink || source.url, source.url);
        if (url.origin !== new URL(source.url).origin || url.protocol !== "https:") continue;
        items.push({
          id: randomUUID(),
          sourceId: source.id,
          sourceName: source.name,
          topic: source.topic,
          title: title.slice(0, 220),
          url: url.toString(),
          summary: capture(chunk, source.summaryPattern).slice(0, 1200),
          scrapedAt: new Date().toISOString(),
        });
      }
    }
    await this.store.saveItems(items);
    return items;
  }
  async analyze(topic: string, itemIds?: string[]): Promise<AiAnalysis> {
    const items = (await this.store.listItems(topic, 100)).filter(
      (item) => !itemIds?.length || itemIds.includes(item.id),
    );
    if (!items.length) throw new Error("No hay novedades scrapeadas para esa temática");
    const analysis = await this.gemini.generate({
      task: "Agrupá y limpiá estas novedades para una nota útil para la audiencia argentina de música. Encontrá el hecho, por qué le importa al público y cualquier dato práctico presente en la fuente. Devolvé título, resumen, hechos confirmados, datos que la fuente no cubre, enfoque y referencias de origen.",
      data: items,
      schema: aiAnalysisSchema,
    });
    // Source identity belongs to the submitted items, not to model-generated identifiers.
    return { ...analysis, sourceIds: items.map((item) => item.id) };
  }
  async createCopy(
    analysis: AiAnalysis,
    format: "post" | "stories" | "both" = "both",
    instructions = "",
  ): Promise<AiCopy> {
    const validatedAnalysis = aiAnalysisSchema.parse(analysis);
    const sourceItems = (await this.store.listItems(undefined, 200))
      .filter((item) => validatedAnalysis.sourceIds.includes(item.id))
      .map(({ id, sourceName, topic, title, url, summary, scrapedAt }) => ({
        id,
        sourceName,
        topic,
        title,
        url,
        summary,
        scrapedAt,
      }));
    if (!sourceItems.length) throw new Error("No se encontraron las fuentes de esta noticia");
    return this.gemini.generate({
      task: `Creá un borrador de nota web y copy listo para Instagram en formato ${format}. La nota debe explicar la noticia con contexto, atribuirla y tener entre 2 y 5 párrafos breves si el material alcanza. El caption debe ser breve (2 o 3 párrafos), aportar un dato concreto y práctico cuando esté verificado, y no repetir literalmente el arte. Para stories, armá una secuencia breve y progresiva. Incluí artículo, instagramPost, stories y hashtags en el JSON.`,
      data: { analysis: validatedAnalysis, sourceItems },
      schema: aiCopySchema,
      instructions: [aiNewsEditorialGuidance, instructions].filter(Boolean).join(" "),
    });
  }
}
