import test from "node:test";
import assert from "node:assert/strict";
import { OpenverseClient } from "./openverse.js";

test("Openverse filtra licencias de uso comercial/derivados pero no afirma que estén verificadas", async () => {
  let requested: URL | undefined;
  const fetcher: typeof fetch = async (input) => {
    requested = new URL(String(input));
    return Response.json({
      result_count: 2,
      results: [
        {
          id: "cc-by-photo",
          title: "Show under",
          url: "https://images.example/show.jpg",
          foreign_landing_url: "https://source.example/show",
          creator: "Fotógrafa",
          creator_url: "https://source.example/creator",
          license: "by",
          license_version: "4.0",
          license_url: "https://creativecommons.org/licenses/by/4.0/",
          provider: "Flickr",
          source: "flickr",
          thumbnail: "https://images.example/thumb.jpg",
          width: 1200,
          height: 800,
          tags: [{ name: "recital" }],
        },
        {
          id: "nc-photo",
          title: "No comercial",
          url: "https://images.example/nc.jpg",
          foreign_landing_url: "https://source.example/nc",
          creator: "Autor",
          license: "by-nc",
          license_version: "4.0",
          license_url: "https://creativecommons.org/licenses/by-nc/4.0/",
          provider: "Flickr",
          source: "flickr",
        },
      ],
    });
  };
  const candidates = await new OpenverseClient(fetcher).search("banda recital Buenos Aires", 5);
  assert.equal(requested?.searchParams.get("q"), "banda recital Buenos Aires");
  assert.equal(requested?.searchParams.get("license_type"), "commercial,modification");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.license, "by");
  assert.equal(candidates[0]?.rightsVerified, false);
});

test("Openverse rechaza búsquedas vacías y credenciales parciales", async (context) => {
  const client = new OpenverseClient(async () => Response.json({ results: [], result_count: 0 }));
  await assert.rejects(() => client.search("  "), /al menos 3 caracteres/);
  const id = process.env.OPENVERSE_CLIENT_ID;
  const secret = process.env.OPENVERSE_CLIENT_SECRET;
  process.env.OPENVERSE_CLIENT_ID = "configured-id";
  delete process.env.OPENVERSE_CLIENT_SECRET;
  context.after(() => {
    if (id === undefined) delete process.env.OPENVERSE_CLIENT_ID;
    else process.env.OPENVERSE_CLIENT_ID = id;
    if (secret === undefined) delete process.env.OPENVERSE_CLIENT_SECRET;
    else process.env.OPENVERSE_CLIENT_SECRET = secret;
  });
  await assert.rejects(() => client.search("rock band"), /deben configurarse juntos/);
});

test("la descarga de Openverse exige host HTTPS permitido, MIME de imagen y tamaño acotado", async () => {
  const candidate = (imageUrl: string) => ({
    provider: "openverse" as const,
    id: "1",
    title: "",
    imageUrl,
    sourceUrl: "https://source.example/photo",
    creator: "A",
    creatorUrl: null,
    license: "by",
    licenseVersion: "4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    providerName: "Flickr",
    sourceName: "flickr",
    thumbnailUrl: null,
    width: 1000,
    height: 800,
    tags: [],
    rightsVerified: false as const,
  });
  const bytes = new Uint8Array([1, 2, 3]);
  const client = new OpenverseClient(async (_input, init) => {
    assert.equal(init?.redirect, "manual");
    return new Response(bytes, { headers: { "content-type": "image/jpeg", "content-length": "3" } });
  });
  const image = await client.download(candidate("https://images.unsplash.com/photo"));
  assert.equal(image.mimeType, "image/jpeg");
  assert.deepEqual(image.bytes, Buffer.from(bytes));
  await assert.rejects(() => client.download(candidate("http://images.unsplash.com/photo")), /host.*permitido/);
  await assert.rejects(() => client.download(candidate("https://127.0.0.1/private")), /host.*permitido/);
  const htmlClient = new OpenverseClient(
    async () => new Response("<html>", { headers: { "content-type": "text/html" } }),
  );
  await assert.rejects(() => htmlClient.download(candidate("https://images.unsplash.com/photo")), /JPG, PNG o WebP/);
  const largeClient = new OpenverseClient(
    async () =>
      new Response(new Uint8Array(2_700_000), {
        headers: { "content-type": "image/jpeg", "content-length": "2700000" },
      }),
  );
  await assert.rejects(() => largeClient.download(candidate("https://images.unsplash.com/photo")), /2,5 MiB/);
});
