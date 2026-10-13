import test from "node:test";
import assert from "node:assert/strict";
import { MetaPublisher } from "./meta.js";

const item = (patch: Record<string, unknown> = {}) =>
  ({
    id: "id",
    slug: "nota",
    createdAt: "",
    updatedAt: "",
    publishedAt: null,
    remoteIds: {},
    lastError: null,
    attempts: 0,
    nextAttemptAt: null,
    containerId: null,
    publishedMediaId: null,
    type: "post",
    title: "Título",
    summary: "Resumen",
    body: "",
    status: "approved",
    channels: ["instagram"],
    assets: [
      {
        id: "foto",
        url: "https://example.com/foto.jpg",
        localPath: "",
        mediaType: "image",
        altText: "",
        credit: "",
      },
    ],
    instagramCopy: "Copy",
    facebookCopy: "",
    tags: [],
    scheduledAt: null,
    notes: "",
    ...patch,
  }) as any;

test("simula Meta sin credenciales ni requests externos", async () => {
  const result = await new MetaPublisher().publish(item(), true);
  assert.equal(result.instagram, "dry-run-id");
});

test("valida que Stories y Reels tengan el formato correcto", async () => {
  const publisher = new MetaPublisher();
  await assert.rejects(
    () => publisher.publish(item({ type: "story", assets: [item().assets[0], item().assets[0]] }), true),
    /Stories.*único/,
  );
  await assert.rejects(() => publisher.publish(item({ type: "reel" }), true), /Reels.*video/);
});

test("exige medio para Instagram y credenciales para publicación real", async () => {
  await assert.rejects(() => new MetaPublisher().publish(item({ assets: [] }), true), /al menos una imagen/);
  const oldToken = process.env.META_ACCESS_TOKEN;
  delete process.env.META_ACCESS_TOKEN;
  const publisher = new MetaPublisher({
    resolveAssets: async (value: any) => value,
    validateAssets: async () => undefined,
  } as any);
  await assert.rejects(() => publisher.publish(item(), false), /META_ACCESS_TOKEN/);
  if (oldToken === undefined) delete process.env.META_ACCESS_TOKEN;
  else process.env.META_ACCESS_TOKEN = oldToken;
});

test("publica video de Facebook mediante file_url", async () => {
  const oldToken = process.env.META_ACCESS_TOKEN;
  process.env.META_ACCESS_TOKEN = "token";
  const oldPage = process.env.META_PAGE_ID;
  process.env.META_PAGE_ID = "page";
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ id: "facebook-video" }), {
      status: 200,
    })) as typeof fetch;
  const publisher = new MetaPublisher({
    resolveAssets: async (value: any) => value,
    validateAssets: async () => undefined,
  } as any);
  const result = await publisher.publish(
    item({
      channels: ["facebook"],
      assets: [
        {
          id: "v",
          url: "https://example.com/v.mp4",
          localPath: "",
          mediaType: "video",
        },
      ],
    }),
    false,
  );
  assert.equal(result.facebook, "facebook-video");
  globalThis.fetch = oldFetch;
  if (oldToken === undefined) delete process.env.META_ACCESS_TOKEN;
  else process.env.META_ACCESS_TOKEN = oldToken;
  if (oldPage === undefined) delete process.env.META_PAGE_ID;
  else process.env.META_PAGE_ID = oldPage;
});

test("consulta insights de Instagram y normaliza métricas", async () => {
  const oldToken = process.env.META_ACCESS_TOKEN;
  const oldFetch = globalThis.fetch;
  process.env.META_ACCESS_TOKEN = "token";
  globalThis.fetch = (async (input) => {
    assert.match(String(input), /media-1\/insights/);
    return new Response(
      JSON.stringify({
        data: [
          { name: "likes", values: [{ value: 10 }] },
          { name: "comments", values: [{ value: 2 }] },
          { name: "saved", values: [{ value: 3 }] },
          { name: "shares", values: [{ value: 4 }] },
          { name: "reach", values: [{ value: 100 }] },
          { name: "impressions", values: [{ value: 130 }] },
          { name: "plays", values: [{ value: 7 }] },
          { name: "total_interactions", values: [{ value: 19 }] },
        ],
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  try {
    const metrics = await new MetaPublisher().getInstagramMetrics("media-1");
    assert.deepEqual(metrics, {
      likes: 10,
      comments: 2,
      saves: 3,
      shares: 4,
      reach: 100,
      impressions: 130,
      plays: 7,
      totalInteractions: 19,
      fetchedAt: metrics.fetchedAt,
    });
  } finally {
    globalThis.fetch = oldFetch;
    if (oldToken === undefined) delete process.env.META_ACCESS_TOKEN;
    else process.env.META_ACCESS_TOKEN = oldToken;
  }
});

test("las métricas de Instagram en modo simulación no requieren Meta", async () => {
  const oldToken = process.env.META_ACCESS_TOKEN;
  delete process.env.META_ACCESS_TOKEN;
  try {
    const metrics = await new MetaPublisher().getInstagramMetrics("media-1", true);
    assert.equal(metrics.likes, 0);
    assert.equal(metrics.totalInteractions, 0);
  } finally {
    if (oldToken === undefined) delete process.env.META_ACCESS_TOKEN;
    else process.env.META_ACCESS_TOKEN = oldToken;
  }
});

test("propaga errores de Meta al consultar insights", async () => {
  const oldToken = process.env.META_ACCESS_TOKEN;
  const oldFetch = globalThis.fetch;
  process.env.META_ACCESS_TOKEN = "token";
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: { message: "Permiso insuficiente", code: 10 } }), {
      status: 403,
    })) as typeof fetch;
  try {
    await assert.rejects(() => new MetaPublisher().getInstagramMetrics("media-1"), /No se pudo consultar/);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldToken === undefined) delete process.env.META_ACCESS_TOKEN;
    else process.env.META_ACCESS_TOKEN = oldToken;
  }
});
