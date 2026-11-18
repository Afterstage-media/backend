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
import { aiAnalysisSchema, aiCopySchema, aiWeeklyDigestSchema } from "../domain/ai-news/types.js";
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
const decodeXml = (value: string) =>
  value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_match, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const xmlValue = (xml: string, tag: string) => {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(xml);
  return match?.[1] ? decodeXml(match[1]) : "";
};
const htmlValue = (value: string) => decodeXml(decodeXml(value)).slice(0, 1200);
const cleanNewsUrl = (value: string, base: string) => {
  try {
    const url = new URL(value, base);
    if (url.protocol !== "https:" || url.username || url.password) return "";
    return url.toString();
  } catch {
    return "";
  }
};
const newsEntry = (xml: string) => xml.match(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi) ?? [];
const feedLink = (entry: string, base: string) => {
  const atomLinks = [...entry.matchAll(/<link\b([^>]*)\/?\s*>/gi)];
  const alternate = atomLinks.find((match) => !/\brel=["'](?:self|enclosure)["']/i.test(match[1] ?? ""));
  const href = alternate?.[1]?.match(/\bhref=["']([^"']+)["']/i)?.[1];
  return cleanNewsUrl(href || xmlValue(entry, "link"), base);
};
const titleTokens = (title: string) =>
  new Set(
    title
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/\s+[|–—-]\s+[^|–—-]{2,60}$/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter(
        (word) =>
          word.length > 2 &&
          !/^(con|para|por|una|uno|del|las|los|que|como|desde|sobre|tras|entre|ante|este|esta|sus|mas|hoy|sera|vuelve|llega|anuncia|anuncio|musica)$/.test(
            word,
          ),
      ),
  );
const groupSameStories = (items: ScrapedItem[]) => {
  const groups: ScrapedItem[][] = [];
  for (const item of items) {
    const words = titleTokens(item.title);
    const match = groups.find((group) =>
      group.some((other) => {
        const otherWords = titleTokens(other.title);
        const shared = [...words].filter((word) => otherWords.has(word)).length;
        return shared >= 3 && shared / Math.min(words.size || 1, otherWords.size || 1) >= 0.68;
      }),
    );
    if (match) match.push(item);
    else groups.push([item]);
  }
  return groups;
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
      format: parsed.format ?? (parsed.itemPattern ? "html" : "rss"),
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
  async discoverWeekly(
    query = "música Argentina",
    days = 7,
    limit = 10,
    correlationId = "",
  ): Promise<{
    query: string;
    windowStart: string;
    windowEnd: string;
    stories: Array<{ itemIds: string[]; relevanceScore: number; reason: string; items: ScrapedItem[] }>;
    candidatesScanned: number;
    duplicateItemsGrouped: number;
    rankingMethod: "gemini" | "recency-fallback";
  }> {
    const cleanQuery = query.trim().slice(0, 180);
    if (!cleanQuery) throw new Error("Indicá qué tema musical querés buscar");
    const windowDays = Math.min(Math.max(Math.trunc(days), 1), 14);
    const storyLimit = Math.min(Math.max(Math.trunc(limit), 1), 10);
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - windowDays * 24 * 60 * 60 * 1000);
    const now = Date.now();
    const broadMusicQuery =
      /m[uú]sica/i.test(cleanQuery) && /(argentina|noticias|artistas|festivales|discos|recitales)/i.test(cleanQuery);
    const searchQueries = broadMusicQuery
      ? [
          `${cleanQuery} (lanzamiento OR álbum OR disco OR single OR banda OR artista)`,
          `${cleanQuery} (recital OR concierto OR gira OR festival OR show)`,
          `${cleanQuery} (industria musical OR premios OR streaming OR sellos)`,
        ]
      : [cleanQuery];
    const responses = await Promise.allSettled(
      searchQueries.map(async (searchQuery) => {
        const search = new URL("https://news.google.com/rss/search");
        search.searchParams.set("q", `${searchQuery} when:${windowDays}d`);
        search.searchParams.set("hl", "es-419");
        search.searchParams.set("gl", "AR");
        search.searchParams.set("ceid", "AR:es-419");
        const response = await fetch(search, {
          headers: {
            "User-Agent": "AfterstageNewsBot/1.0 (+https://afterstage.ar)",
            Accept: "application/rss+xml, application/xml, text/xml",
          },
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return readHtml(response, 1_500_000);
      }),
    );
    const successfulFeeds = responses.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    if (!successfulFeeds.length) throw new Error("No se pudo consultar ninguna fuente de noticias en este momento");
    const candidateMap = new Map<string, ScrapedItem>();
    for (const xml of successfulFeeds) {
      for (const entry of newsEntry(xml)) {
        const title = xmlValue(entry, "title");
        const url = feedLink(entry, "https://news.google.com/");
        const publishedAt = Date.parse(
          xmlValue(entry, "pubDate") ||
            xmlValue(entry, "published") ||
            xmlValue(entry, "updated") ||
            xmlValue(entry, "dc:date"),
        );
        if (
          !title ||
          !url ||
          !Number.isFinite(publishedAt) ||
          publishedAt < windowStart.getTime() ||
          publishedAt > now + 2 * 60 * 60 * 1000
        )
          continue;
        const sourceMatch = /<source\b[^>]*>([\s\S]*?)<\/source>/i.exec(entry);
        const sourceName = sourceMatch?.[1] ? decodeXml(sourceMatch[1]) : "Google News";
        const description = htmlValue(
          xmlValue(entry, "content:encoded") || xmlValue(entry, "description") || xmlValue(entry, "summary"),
        );
        const item: ScrapedItem = {
          id: randomUUID(),
          sourceId: "google-news-rss",
          sourceName,
          topic: cleanQuery.slice(0, 80),
          title: title.slice(0, 220),
          url,
          summary: description,
          scrapedAt: new Date(publishedAt).toISOString(),
        };
        const previous = candidateMap.get(url);
        if (!previous || item.summary.length > previous.summary.length) candidateMap.set(url, item);
      }
    }
    const candidates = [...candidateMap.values()]
      .sort((left, right) => right.scrapedAt.localeCompare(left.scrapedAt))
      .slice(0, 120);
    if (!candidates.length)
      throw new Error("No encontré noticias recientes con esos términos. Probá una búsqueda más amplia.");
    await this.store.saveItems(candidates);
    const candidateUrls = new Set(candidates.map((item) => item.url));
    const stored = await this.store.listItems(cleanQuery.slice(0, 80), 200);
    const canonicalByUrl = new Map(
      stored.filter((item) => candidateUrls.has(item.url)).map((item) => [item.url, item]),
    );
    const items = candidates.flatMap((item) => (canonicalByUrl.has(item.url) ? [canonicalByUrl.get(item.url)!] : []));
    const groups = groupSameStories(items);
    const rankedGroups = groups.slice(0, 60);
    const groupLeads = rankedGroups.map(
      (group) => [...group].sort((a, b) => b.scrapedAt.localeCompare(a.scrapedAt))[0]!,
    );
    let stories: Array<{ itemIds: string[]; relevanceScore: number; reason: string; items: ScrapedItem[] }> = [];
    let rankingMethod: "gemini" | "recency-fallback" = "gemini";
    try {
      const ranked = await this.gemini.generate({
        task: `Elegí hasta ${storyLimit} noticias musicales publicadas en Argentina entre ${windowStart.toISOString()} y ${windowEnd.toISOString()}. La entrada ya está agrupada por hecho y contiene un índice por historia. Priorizá lanzamientos, anuncios, giras, festivales, cambios relevantes de la industria y noticias de artistas con interés periodístico. Excluí agendas institucionales rutinarias, resultados irrelevantes o contenido que solo mencione música de paso. Si hay al menos una noticia musical concreta, devolvé al menos una historia. Devolvé stories con itemIndexes (índices enteros existentes, desde 0), relevanceScore (1–100) y reason breve. No devuelvas títulos ni enlaces nuevos.`,
        data: groupLeads.map(({ sourceName, title, url, summary, scrapedAt }, index) => ({
          index,
          sourceName,
          title,
          url,
          summary: summary.slice(0, 500),
          publishedAt: scrapedAt,
        })),
        schema: aiWeeklyDigestSchema,
      });
      stories = ranked.stories
        .flatMap((story) => {
          const indexes = [...new Set(story.itemIndexes)].filter((index) => index >= 0 && index < rankedGroups.length);
          const grouped = [...new Set(indexes.flatMap((index) => rankedGroups[index]!.map((item) => item.id)))].slice(
            0,
            10,
          );
          return grouped.length
            ? [
                {
                  itemIds: grouped,
                  relevanceScore: story.relevanceScore,
                  reason: story.reason,
                  items: grouped.flatMap((id) => {
                    const item = items.find((candidate) => candidate.id === id);
                    return item ? [item] : [];
                  }),
                },
              ]
            : [];
        })
        .slice(0, storyLimit);
    } catch (error) {
      rankingMethod = "recency-fallback";
      console.warn(
        JSON.stringify({
          at: new Date().toISOString(),
          level: "warn",
          service: "afterstage-social-manager",
          event: "ai_news_weekly_gemini_fallback",
          correlationId,
          errorType: error instanceof Error ? error.name : "UnknownError",
        }),
      );
    }
    if (!stories.length) {
      rankingMethod = "recency-fallback";
      stories = groups
        .map((group) => {
          const sorted = [...group].sort((a, b) => b.scrapedAt.localeCompare(a.scrapedAt)).slice(0, 10);
          return {
            itemIds: sorted.map((item) => item.id),
            relevanceScore: 50,
            reason: "Resultado reciente agrupado por similitud de titulares; revisar relevancia y fuentes.",
            items: sorted,
          };
        })
        .slice(0, storyLimit);
    }
    return {
      query: cleanQuery,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      stories,
      candidatesScanned: candidates.length,
      duplicateItemsGrouped: candidates.length - groups.length,
      rankingMethod,
    };
  }
  async scrape(sourceId?: string) {
    const sources = (await this.store.listSources()).filter(
      (item) => item.enabled && (!sourceId || item.id === sourceId),
    );
    const items: ScrapedItem[] = [];
    for (const source of sources) {
      const sourceFormat = source.format ?? (source.itemPattern ? "html" : "rss");
      await assertPublicUrl(source.url);
      const response = await fetch(source.url, {
        headers: {
          "User-Agent": "AfterstageNewsBot/1.0 (+https://afterstage.ar)",
          Accept:
            sourceFormat === "rss"
              ? "application/rss+xml,application/atom+xml,application/xml,text/xml"
              : "text/html,application/xhtml+xml",
        },
        redirect: "error",
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) throw new Error(`No se pudo leer ${source.name}: HTTP ${response.status}`);
      const type = response.headers.get("content-type") ?? "";
      const body = await readHtml(response, 1_500_000);
      const isXml = type.includes("xml") || type.includes("rss") || type.includes("atom");
      if (sourceFormat === "rss" || isXml) {
        const entries = newsEntry(body);
        for (const entry of entries.slice(0, source.maxItems)) {
          const title = xmlValue(entry, "title");
          const url = feedLink(entry, source.url);
          if (!title || !url) continue;
          const published = Date.parse(
            xmlValue(entry, "pubDate") ||
              xmlValue(entry, "published") ||
              xmlValue(entry, "updated") ||
              xmlValue(entry, "dc:date"),
          );
          const rawSummary =
            xmlValue(entry, "content:encoded") || xmlValue(entry, "description") || xmlValue(entry, "summary");
          items.push({
            id: randomUUID(),
            sourceId: source.id,
            sourceName: source.name,
            topic: source.topic,
            title: title.slice(0, 220),
            url,
            summary: htmlValue(rawSummary),
            scrapedAt: Number.isFinite(published) ? new Date(published).toISOString() : new Date().toISOString(),
          });
        }
      } else {
        if (!type.includes("text/html") && !type.includes("application/xhtml+xml"))
          throw new Error(`La fuente ${source.name} no respondió HTML ni un feed RSS/Atom`);
        if (!source.itemPattern) throw new Error(`La fuente HTML ${source.name} necesita una regex de elementos`);
        const chunks = body.match(new RegExp(source.itemPattern, "gis")) ?? [];
        for (const chunk of chunks.slice(0, source.maxItems)) {
          const title = capture(chunk, source.titlePattern ?? "<h[1-3][^>]*>([\\s\\S]*?)<\\/h[1-3]>");
          const rawLink = capture(chunk, source.linkPattern ?? "href=[\"']([^\"']{1,1000})[\"']");
          if (!title) continue;
          const url = cleanNewsUrl(rawLink || source.url, source.url);
          if (!url || new URL(url).origin !== new URL(source.url).origin) continue;
          items.push({
            id: randomUUID(),
            sourceId: source.id,
            sourceName: source.name,
            topic: source.topic,
            title: title.slice(0, 220),
            url,
            summary: capture(chunk, source.summaryPattern ?? "<p[^>]*>([\\s\\S]*?)<\\/p>").slice(0, 1200),
            scrapedAt: new Date().toISOString(),
          });
        }
      }
    }
    const uniqueItems = [...new Map(items.map((item) => [item.url, item])).values()];
    await this.store.saveItems(uniqueItems);
    // Return the canonical stored records so repeating a scrape never creates a
    // second Gemini input for a URL already seen by another source or run.
    const urls = new Set(uniqueItems.map((item) => item.url));
    const stored = await this.store.listItems(undefined, 200);
    const byUrl = new Map(stored.filter((item) => urls.has(item.url)).map((item) => [item.url, item]));
    return [...urls].flatMap((url) => (byUrl.has(url) ? [byUrl.get(url)!] : []));
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
      task: `Creá un borrador de nota web y copy listo para Instagram en formato ${format}. La nota debe explicar la noticia con contexto, atribuirla y tener entre 2 y 5 párrafos breves si el material alcanza. El caption debe ser breve (2 o 3 párrafos), aportar un dato concreto y práctico cuando esté verificado, y no repetir literalmente el arte. Para stories, armá una secuencia breve y progresiva. Recomendá un tratamiento visual: preferí source_image solo si las fuentes incluyen una imagen editorial verificable; si no, sugerí editorial_illustration y describí una búsqueda/ilustración que no aparente ser una foto documental; si la noticia no admite un visual responsable, elegí no_image. No inventes una URL de imagen: sourceUrl solo puede ser una URL de imagen literal provista por la fuente; en otro caso null. Incluí artículo, instagramPost, stories, hashtags e imageRecommendation en el JSON.`,
      data: { analysis: validatedAnalysis, sourceItems },
      schema: aiCopySchema,
      instructions: [aiNewsEditorialGuidance, instructions].filter(Boolean).join(" "),
    });
  }
  async createPackageFromItems(query: string, itemIds: string[], instructions = ""): Promise<AiCopy> {
    const ids = [...new Set(itemIds)].slice(0, 10);
    if (!ids.length) throw new Error("Seleccioná una noticia con fuentes asociadas");
    const available = await this.store.listItems(query.trim().slice(0, 80), 200);
    const sourceItems = available
      .filter((item) => ids.includes(item.id))
      .map(({ id, sourceName, topic, title, url, summary, scrapedAt }) => ({
        id,
        sourceName,
        topic,
        title,
        url,
        summary,
        publishedAt: scrapedAt,
      }));
    if (!sourceItems.length) throw new Error("Las fuentes de esta noticia ya no están disponibles");
    return this.gemini.generate({
      task: "Creá un paquete editorial completo basado únicamente en las fuentes enviadas: título, bajada y nota web de 2–5 párrafos breves con atribución; copy de Instagram de 2–3 párrafos que complemente la nota; secuencia de hasta 3 historias; y entre 3 y 5 hashtags específicos. Fusioná fuentes que informan el mismo hecho sin repetir texto. Separá lo no confirmado dentro del artículo con atribución prudente o excluilo; nunca completes huecos con conocimiento propio. Las fuentes no contienen archivos de imagen: imageRecommendation debe ser editorial_illustration o no_image, sourceUrl null y debe incluir un brief visual que no simule una foto documental.",
      data: { query, sourceItems },
      schema: aiCopySchema,
      instructions: [aiNewsEditorialGuidance, instructions].filter(Boolean).join(" "),
    });
  }
}
