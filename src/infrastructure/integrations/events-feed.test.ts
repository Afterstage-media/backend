import test from "node:test";
import assert from "node:assert/strict";
import { parseEventsFeed } from "./events-feed.js";

test("parsea RSS y Atom de eventos próximos", () => {
  const xml = `<rss><channel><item><title>Las Perlas en Niceto</title><link>https://example.com/evento</link><pubDate>2099-10-11T21:00:00Z</pubDate><venue>Niceto Club</venue><city>Buenos Aires</city><artist>Las Perlas</artist></item><item><title>Fecha pasada</title><pubDate>2020-01-01T00:00:00Z</pubDate></item></channel></rss>`;
  const events = parseEventsFeed(xml, "https://example.com/feed.xml");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.name, "Las Perlas en Niceto");
  assert.equal(events[0]?.venue, "Niceto Club");
  assert.equal(events[0]?.url, "https://example.com/evento");
});

test("tolera fechas inválidas sin romper el feed", () => {
  const events = parseEventsFeed(
    `<feed><entry><title><![CDATA[Evento sin fecha]]></title><link href="https://example.com/e" /></entry></feed>`,
    "https://example.com/atom.xml",
  );
  assert.equal(events.length, 1);
  assert.equal(events[0]?.startsAt, null);
});
