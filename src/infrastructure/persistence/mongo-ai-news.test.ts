import assert from "node:assert/strict";
import test from "node:test";
import { mongoNewsItemToScrapedItem } from "./mongo-news-mapper.js";

test("restores Mongo's _id as the scraped news item's public id", () => {
  const item = mongoNewsItemToScrapedItem({
    _id: "d750fe97-ff24-405f-936b-8d8b87bea60d",
    sourceId: "google-news-rss",
    sourceName: "Medio musical",
    topic: "música Argentina",
    title: "Un lanzamiento musical",
    url: "https://news.google.com/rss/articles/example",
    summary: "Anuncio de un álbum",
    scrapedAt: "2026-11-19T00:00:00.000Z",
  });

  assert.equal(item.id, "d750fe97-ff24-405f-936b-8d8b87bea60d");
  assert.equal("_id" in item, false);
});
