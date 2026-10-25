import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MediaAssetStore } from "./media-assets.js";

const onePixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test("guarda una imagen base64 en el almacenamiento de medios y devuelve sus metadatos públicos", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "afterstage-media-assets-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new MediaAssetStore(directory, "https://afterstage.test");

  const [asset] = await store.createImages([
    {
      base64: `data:image/png;base64,${onePixelPng}`,
      filename: "pixel.png",
      altText: "Píxel de prueba",
      credit: "Prueba MCP",
    },
  ]);

  assert.ok(asset);
  assert.equal(asset.mediaType, "image");
  assert.equal(asset.url, `https://afterstage.test/media/${asset.localPath}`);
  assert.equal(asset.altText, "Píxel de prueba");
  assert.equal(asset.credit, "Prueba MCP");
  const stored = await readFile(path.join(directory, asset.localPath));
  assert.deepEqual(stored.subarray(0, 8), Buffer.from("89504e470d0a1a0a", "hex"));

  await store.remove([asset]);
  await assert.rejects(() => access(path.join(directory, asset.localPath)));
});

test("rechaza una imagen cuyo contenido no coincide con el MIME declarado", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "afterstage-media-assets-invalid-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new MediaAssetStore(directory, "https://afterstage.test");

  await assert.rejects(
    () => store.createImages([{ base64: onePixelPng, mimeType: "image/jpeg", altText: "", credit: "" }]),
    /no coincide con su tipo MIME/,
  );
});
