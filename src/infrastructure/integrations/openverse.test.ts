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
