import { z } from "zod";

const openverseImageSchema = z.object({
  id: z.string(),
  title: z.string().nullable().default(""),
  url: z.string().url(),
  foreign_landing_url: z.string().url(),
  creator: z.string().nullable().default(""),
  creator_url: z.string().url().nullable().default(null),
  license: z.string(),
  license_version: z.string().nullable().default(""),
  license_url: z.string().url().nullable().default(null),
  provider: z.string(),
  source: z.string(),
  thumbnail: z.string().url().nullable().default(null),
  width: z.number().nullable().default(null),
  height: z.number().nullable().default(null),
  tags: z.array(z.object({ name: z.string() }).passthrough()).default([]),
});

const openverseResponseSchema = z.object({
  results: z.array(openverseImageSchema),
  result_count: z.number().int().nonnegative(),
});

// Filter out non-commercial and no-derivatives terms before a result reaches an editor.
// This is discovery only: Openverse explicitly does not verify the license claimed by each item.
const discoverableLicenses = ["cc0", "pdm", "by", "by-sa"] as const;

export type PhotoCandidate = {
  provider: "openverse";
  id: string;
  title: string;
  imageUrl: string;
  sourceUrl: string;
  creator: string;
  creatorUrl: string | null;
  license: string;
  licenseVersion: string;
  licenseUrl: string | null;
  providerName: string;
  sourceName: string;
  thumbnailUrl: string | null;
  width: number | null;
  height: number | null;
  tags: string[];
  rightsVerified: false;
};

export class OpenverseClient {
  private searchRequests: number[] = [];

  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async search(query: string, limit = 10): Promise<PhotoCandidate[]> {
    const normalized = query.trim().slice(0, 200);
    if (normalized.length < 3) throw new Error("La búsqueda de fotos necesita al menos 3 caracteres");
    const now = Date.now();
    this.searchRequests = this.searchRequests.filter((timestamp) => now - timestamp < 60_000);
    if (this.searchRequests.length >= 30)
      throw new Error("Se alcanzó el límite local de búsquedas de Openverse; esperá un minuto");
    this.searchRequests.push(now);
    const boundedLimit = Math.max(1, Math.min(20, Math.trunc(limit)));
    const url = new URL("https://api.openverse.org/v1/images/");
    url.searchParams.set("q", normalized);
    url.searchParams.set("page_size", String(boundedLimit));
    url.searchParams.set("license", discoverableLicenses.join(","));
    url.searchParams.set("license_type", "commercial,modification");
    url.searchParams.set("filter_dead", "true");

    const clientId = process.env.OPENVERSE_CLIENT_ID;
    const clientSecret = process.env.OPENVERSE_CLIENT_SECRET;
    if (Boolean(clientId) !== Boolean(clientSecret)) {
      throw new Error("OPENVERSE_CLIENT_ID y OPENVERSE_CLIENT_SECRET deben configurarse juntos");
    }

    const headers: Record<string, string> = { Accept: "application/json" };
    if (clientId && clientSecret) {
      const tokenResponse = await this.fetcher("https://api.openverse.org/v1/auth_tokens/token/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "client_credentials",
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!tokenResponse.ok) throw new Error(`Openverse auth respondió ${tokenResponse.status}`);
      const token = z.object({ access_token: z.string().min(1) }).parse(await tokenResponse.json());
      headers.Authorization = `Bearer ${token.access_token}`;
    }

    const response = await this.fetcher(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Openverse search respondió ${response.status}`);
    const payload = openverseResponseSchema.parse(await response.json());
    return payload.results
      .filter((image) => discoverableLicenses.includes(image.license as (typeof discoverableLicenses)[number]))
      .map((image) => ({
        provider: "openverse" as const,
        id: image.id,
        title: image.title ?? "",
        imageUrl: image.url,
        sourceUrl: image.foreign_landing_url,
        creator: image.creator ?? "",
        creatorUrl: image.creator_url,
        license: image.license,
        licenseVersion: image.license_version ?? "",
        licenseUrl: image.license_url,
        providerName: image.provider,
        sourceName: image.source,
        thumbnailUrl: image.thumbnail,
        width: image.width,
        height: image.height,
        tags: image.tags.map((tag) => tag.name).slice(0, 30),
        rightsVerified: false as const,
      }));
  }
}
