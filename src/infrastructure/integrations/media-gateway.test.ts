import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MediaGateway } from "./media-gateway.js";

test("resuelve medios locales con URL pública y bloquea path traversal", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "medio-under-media-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "foto.jpg"), "foto");
  const oldRoot = process.env.MEDIA_ROOT;
  const oldTunnel = process.env.CLOUDFLARE_TUNNEL_URL;
  process.env.MEDIA_ROOT = root;
  process.env.CLOUDFLARE_TUNNEL_URL = "https://media.example/tunnel/";
  const gateway = new MediaGateway(undefined, async () => [{ address: "93.184.216.34", family: 4 }] as never);
  assert.equal(
    await gateway.resolve({
      id: "1",
      localPath: "foto.jpg",
      url: "",
      mediaType: "image",
      altText: "",
      credit: "",
    }),
    "https://media.example/tunnel/media/foto.jpg",
  );
  await assert.rejects(
    () =>
      gateway.resolve({
        id: "2",
        localPath: "../secret",
        url: "",
        mediaType: "image",
        altText: "",
        credit: "",
      }),
    /fuera de MEDIA_ROOT/,
  );
  if (oldRoot === undefined) delete process.env.MEDIA_ROOT;
  else process.env.MEDIA_ROOT = oldRoot;
  if (oldTunnel === undefined) delete process.env.CLOUDFLARE_TUNNEL_URL;
  else process.env.CLOUDFLARE_TUNNEL_URL = oldTunnel;
});

test("valida tipo MIME público y detecta archivos ausentes", async () => {
  const gateway = new MediaGateway(undefined, async () => [{ address: "93.184.216.34", family: 4 }] as never);
  const previous = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(null, {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    })) as typeof fetch;
  await gateway.validatePublicUrl("https://example.com/foto.jpg", "image");
  await assert.rejects(() => gateway.validatePublicUrl("https://example.com/foto.jpg", "video"), /no un video/);
  globalThis.fetch = previous;
  assert.equal(await gateway.localMediaExists("definitely-missing.jpg"), false);
});

test("rechaza destinos localhost y redes privadas antes de hacer fetch", async () => {
  const gateway = new MediaGateway();
  await assert.rejects(() => gateway.validatePublicUrl("http://127.0.0.1:8787/health", "image"), /red privada/);
  await assert.rejects(() => gateway.validatePublicUrl("http://localhost/secret", "image"), /red privada/);
});
