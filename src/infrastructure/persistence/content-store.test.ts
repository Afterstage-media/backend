import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ContentStore } from "./content-store.js";
import { contentInputSchema } from "../../domain/content/types.js";

test("crea, persiste y actualiza una nota", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "medio-under-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ContentStore(directory);
  const created = await store.create(contentInputSchema.parse({ title: "Una fecha bajo tierra" }));

  assert.equal(created.slug, "una-fecha-bajo-tierra");
  assert.equal((await store.list()).length, 1);

  const updated = await store.update(created.id, {
    status: "review",
    summary: "Crónica de una noche independiente.",
  });
  assert.equal(updated?.status, "review");
  assert.equal((await new ContentStore(directory).get(created.id))?.summary, "Crónica de una noche independiente.");
});

test("serializa escrituras concurrentes sin perder contenido", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "medio-under-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const stores = [new ContentStore(directory), new ContentStore(directory)];
  await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      stores[index % 2]!.create(contentInputSchema.parse({ title: `Nota ${index}` })),
    ),
  );
  assert.equal((await stores[0]!.list()).length, 8);
});
