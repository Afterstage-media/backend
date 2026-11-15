import assert from "node:assert/strict";
import test from "node:test";
import { AiNewsManager, type AiNewsStore } from "./ai-news-manager.js";
import type { NewsSource, ScrapedItem } from "../domain/ai-news/types.js";

class MemoryNewsStore implements AiNewsStore {
  sources: NewsSource[] = [];
  items: ScrapedItem[] = [];
  async listSources() {
    return this.sources;
  }
  async saveSource(source: NewsSource) {
    this.sources = [...this.sources.filter((item) => item.id !== source.id), source];
  }
  async removeSource(id: string) {
    const before = this.sources.length;
    this.sources = this.sources.filter((item) => item.id !== id);
    return this.sources.length < before;
  }
  async listItems(topic?: string) {
    return this.items.filter((item) => !topic || item.topic === topic);
  }
  async saveItems(items: ScrapedItem[]) {
    this.items.push(...items);
  }
}

test("rechaza destinos locales antes de aceptar fuentes", async () => {
  const manager = new AiNewsManager(new MemoryNewsStore());
  await assert.rejects(
    () =>
      manager.saveSource({
        name: "local",
        url: "https://127.0.0.1/a",
        topic: "música",
        itemPattern: "<article>(.*?)</article>",
      }),
    /dirección no pública/,
  );
  await assert.rejects(
    () => manager.saveSource({ name: "mal regex", url: "https://example.com", topic: "música", itemPattern: "(a+)+$" }),
    /alto riesgo/,
  );
});

test("extrae título y enlace de fragmentos HTML acotados por tema", async (context) => {
  const store = new MemoryNewsStore();
  const manager = new AiNewsManager(store);
  const source = await manager.saveSource({
    name: "Fuente test",
    url: "https://example.com/news",
    topic: "lanzamientos",
    itemPattern: "<article\\b[^>]*>[\\s\\S]*?</article>",
    titlePattern: "<h2[^>]*>([^<]+)</h2>",
    linkPattern: "href=[\"']([^\"']+)[\"']",
    summaryPattern: "<p[^>]*>([^<]+)</p>",
  });
  context.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response('<article><h2>Nuevo disco</h2><a href="/news/disco">Leer</a><p>Anuncio oficial</p></article>', {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
  );
  const results = await manager.scrape(source.id);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.sourceId, source.id);
  assert.equal(results[0]?.title, "Nuevo disco");
  assert.equal(results[0]?.url, "https://example.com/news/disco");
  assert.equal(results[0]?.topic, "lanzamientos");
});

test("asigna las referencias desde los ítems enviados y no desde IDs generados por Gemini", async (context) => {
  const store = new MemoryNewsStore();
  const item: ScrapedItem = {
    id: "7096da48-ed8d-4ba3-a4a7-5969ad2d21be",
    sourceId: "1696da48-ed8d-4ba3-a4a7-5969ad2d21be",
    sourceName: "Fuente test",
    topic: "industria musical",
    title: "Anuncio de música",
    url: "https://example.com/news",
    summary: "Resumen confirmado",
    scrapedAt: new Date().toISOString(),
  };
  store.items = [item];
  const oldKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";
  context.after(() => {
    if (oldKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = oldKey;
  });
  context.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      title: "Anuncio de música",
                      summary: "Resumen confirmado",
                      facts: ["Resumen confirmado"],
                      missingFacts: [],
                      suggestedAngle: "Anuncio",
                      sourceIds: ["00000000-0000-0000-0000-000000000000"],
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      ),
  );

  const analysis = await new AiNewsManager(store).analyze(item.topic, [item.id]);
  assert.deepEqual(analysis.sourceIds, [item.id]);
});
