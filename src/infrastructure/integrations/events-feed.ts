import { assertPublicUrl } from "./media-gateway.js";

export type ExternalEvent = {
  id: string;
  name: string;
  artist: string;
  venue: string;
  city: string;
  country?: string;
  latitude?: number | null;
  longitude?: number | null;
  startsAt: string | null;
  status: "planned";
  organizerContactId: null;
  url: string;
  notes: string;
  source: string;
};

const decode = (value: string) =>
  value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
const field = (block: string, names: string[]) => {
  for (const name of names) {
    const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
    if (match?.[1]) return decode(match[1]);
  }
  return "";
};
const linkField = (block: string) =>
  field(block, ["link", "guid"]) || block.match(/<link[^>]+href=["']([^"']+)["']/i)?.[1] || "";
const safeLink = (value: string) => {
  try {
    const url = new URL(value);
    return /^https?:$/i.test(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
};
const coordinate = (value: string, min: number, max: number): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
};

export const parseEventsFeed = (xml: string, source: string): ExternalEvent[] => {
  const blocks = [...xml.matchAll(/<(?:item|entry)\b[^>]*>([\s\S]*?)<\/(?:item|entry)>/gi)].map((match) => match[1]!);
  return blocks
    .map((block, index) => {
      const name = field(block, ["title", "name"]) || "Evento sin título";
      const date = field(block, ["eventDate", "startDate", "startTime", "pubDate", "published", "updated", "date"]);
      const parsedDate = date ? Date.parse(date) : Number.NaN;
      const timestamp = Number.isNaN(parsedDate) ? null : new Date(parsedDate).toISOString();
      const url = safeLink(linkField(block));
      return {
        id: `external-${Buffer.from(`${source}:${url || name}:${index}`).toString("base64url")}`,
        name,
        artist: field(block, ["artist", "performer", "dc:creator"]),
        venue: field(block, ["venue", "location", "place"]),
        city: field(block, ["city", "locality"]),
        country: field(block, ["country", "countryName"]) || "Argentina",
        latitude: coordinate(field(block, ["latitude", "lat", "geo:lat"]), -90, 90),
        longitude: coordinate(field(block, ["longitude", "lng", "lon", "geo:long"]), -180, 180),
        startsAt: timestamp && !Number.isNaN(Date.parse(timestamp)) ? timestamp : null,
        status: "planned" as const,
        organizerContactId: null,
        url,
        notes: field(block, ["description", "summary", "content"]),
        source,
      };
    })
    .filter((item) => !item.startsAt || Date.parse(item.startsAt) >= Date.now());
};

export class EventsFeed {
  private cache: { expiresAt: number; events: ExternalEvent[] } = {
    expiresAt: 0,
    events: [],
  };
  constructor(
    private readonly urls = (process.env.EVENTS_RSS_URLS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    private readonly ttlMs = 5 * 60_000,
  ) {}

  async list(): Promise<ExternalEvent[]> {
    if (this.cache.expiresAt > Date.now()) return this.cache.events;
    const events: ExternalEvent[] = [];
    for (const url of this.urls.slice(0, 10)) {
      try {
        await assertPublicUrl(url);
        const response = await fetch(url, {
          signal: AbortSignal.timeout(8_000),
          headers: {
            Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml",
          },
        });
        if (!response.ok) continue;
        events.push(...parseEventsFeed(await response.text(), url));
      } catch {
        /* una fuente caída no debe ocultar la agenda editorial */
      }
    }
    const unique = [
      ...new Map(
        events.map((event) => [
          `${event.name.toLowerCase()}|${event.startsAt ?? ""}|${event.venue.toLowerCase()}`,
          event,
        ]),
      ).values(),
    ];
    this.cache = {
      expiresAt: Date.now() + this.ttlMs,
      events: unique.sort((a, b) => (a.startsAt ?? "9999").localeCompare(b.startsAt ?? "9999")),
    };
    return this.cache.events;
  }
}
