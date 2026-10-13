import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createApp } from "./app.js";
import { ContentManager } from "../../application/content-manager.js";
import { ContentStore } from "../../infrastructure/persistence/content-store.js";
import { PressManager } from "../../application/press-manager.js";
import { PressStore } from "../../infrastructure/persistence/press-store.js";
import { DirectoryManager } from "../../application/directory-manager.js";
import { DirectoryStore } from "../../infrastructure/persistence/directory-store.js";

const withServer = async (
  app: ReturnType<typeof createApp> extends Promise<infer T> ? T : never,
  run: (base: string) => Promise<void>,
) => {
  const server = await new Promise<import("node:http").Server>((resolve) => {
    const value = app.listen(0, () => resolve(value));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No se pudo abrir el servidor de prueba");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
};

test("expone health, readiness y feed editorial público", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "medio-under-app-public-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const manager = new ContentManager(new ContentStore(directory));
  const item = await manager.create({
    title: "Nota pública",
    channels: ["website"],
  });
  await manager.update(item.id, { status: "review" });
  await manager.update(item.id, { status: "approved" });
  await manager.store.update(item.id, {
    status: "published",
    publishedAt: new Date().toISOString(),
  });
  const oldMongo = process.env.MONGODB_URI;
  const oldAdmin = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = "community-test-admin";
  delete process.env.MONGODB_URI;
  const app = await createApp(manager, new PressManager(new PressStore(directory)));
  await withServer(app, async (base) => {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, "ok");
    const ready = await fetch(`${base}/ready`);
    assert.equal(ready.status, 200);
    assert.equal((await ready.json()).mongo, false);
    const feed = await fetch(`${base}/api/public/content`);
    assert.equal(feed.status, 200);
    const publicItem = (await feed.json())[0];
    assert.equal(publicItem.title, "Nota pública");
    assert.equal(publicItem.remoteIds, undefined);
    assert.equal(publicItem.lastError, undefined);
    assert.equal(publicItem.attempts, undefined);
    const detail = await fetch(`${base}/api/public/content/${item.slug}`);
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).viewCount, 1);
    const metrics = await fetch(`${base}/api/public/metrics`);
    const metricData = await metrics.json();
    assert.equal(metricData.views, 1);
    assert.equal(metricData.press.coveredEvents, 0);
    assert.equal(metricData.press.coverages, 0);
    const article = await fetch(`${base}/notas/${item.slug}`);
    const articleHtml = await article.text();
    assert.equal(article.status, 200);
    assert.match(articleHtml, /data-share=/);
    assert.match(articleHtml, /data-share-instagram/);
    assert.match(articleHtml, /src="\/share\.js"/);
    const submission = await fetch(`${base}/api/public/submissions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer community-test-admin" },
      body: JSON.stringify({
        kind: "Una historia",
        title: "Propuesta real",
        description: "Una propuesta editorial suficientemente detallada.",
        contact: "persona@example.com",
      }),
    });
    assert.equal(submission.status, 201);
    assert.equal((await submission.json()).accepted, true);
    assert.equal((await fetch(`${base}/api/public/events`)).status, 200);
    assert.equal((await fetch(`${base}/rss.xml`)).status, 200);
    assert.equal((await fetch(`${base}/sitemap.xml`)).status, 200);
    assert.equal((await fetch(`${base}/robots.txt`)).status, 200);
  });
  if (oldMongo === undefined) delete process.env.MONGODB_URI;
  else process.env.MONGODB_URI = oldMongo;
  if (oldAdmin === undefined) delete process.env.ADMIN_TOKEN;
  else process.env.ADMIN_TOKEN = oldAdmin;
});

test("combina eventos editoriales con fuentes RSS externas", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "medio-under-events-feed-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const manager = new ContentManager(new ContentStore(directory));
  const press = new PressManager(new PressStore(directory));
  const eventsFeed = {
    list: async () => [
      {
        id: "rss-1",
        name: "Fecha RSS",
        artist: "Banda",
        venue: "Sala",
        city: "CABA",
        startsAt: "2099-01-01T21:00:00.000Z",
        status: "planned" as const,
        organizerContactId: null,
        url: "https://example.com/evento",
        notes: "",
        source: "https://example.com/feed.xml",
      },
    ],
  };
  const app = await createApp(manager, press, eventsFeed);
  await withServer(app, async (base) => {
    const response = await fetch(`${base}/api/public/events`);
    assert.equal(response.status, 200);
    assert.equal((await response.json())[0].name, "Fecha RSS");
  });
});

test("expone el catálogo público sin contactos privados y protege el directorio completo", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "medio-under-directory-api-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const manager = new ContentManager(new ContentStore(directory));
  const directoryManager = new DirectoryManager(new DirectoryStore(directory));
  await directoryManager.create({
    kind: "band",
    name: "Banda API",
    latitude: -34.6037,
    longitude: -58.3816,
    contacts: [{ name: "Manager", role: "Manager", email: "private@example.com" }],
  });
  const oldToken = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = "directory-admin";
  const app = await createApp(
    manager,
    new PressManager(new PressStore(directory)),
    undefined,
    undefined,
    directoryManager,
  );
  await withServer(app, async (base) => {
    const publicResponse = await fetch(`${base}/api/public/directory`, {
      headers: { Authorization: "Bearer directory-admin" },
    });
    const publicItem = (await publicResponse.json())[0];
    assert.equal(publicResponse.status, 200);
    assert.equal(publicItem.name, "Banda API");
    assert.equal(publicItem.contacts, undefined);
    const nearby = await fetch(`${base}/api/public/directory?lat=-34.60&lng=-58.38&radiusKm=5`, {
      headers: { Authorization: "Bearer directory-admin" },
    });
    assert.equal((await nearby.json()).length, 1);
    const privateResponse = await fetch(`${base}/api/directory`, {
      headers: { Authorization: "Bearer directory-admin" },
    });
    assert.equal(privateResponse.status, 200);
    assert.equal((await privateResponse.json())[0].contacts[0].email, "private@example.com");
    const verification = await fetch(`${base}/api/directory/${publicItem.id}/verification`, {
      method: "POST",
      headers: { Authorization: "Bearer directory-admin", "Content-Type": "application/json" },
      body: JSON.stringify({ status: "verified", reliabilityScore: 90 }),
    });
    assert.equal(verification.status, 200);
    assert.equal((await verification.json()).reliabilityScore, 90);
  });
  if (oldToken === undefined) delete process.env.ADMIN_TOKEN;
  else process.env.ADMIN_TOKEN = oldToken;
});

test("aplica roles, token bearer y rate limit", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "medio-under-app-auth-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const previous = {
    admin: process.env.ADMIN_TOKEN,
    users: process.env.AUTH_USERS_JSON,
    rate: process.env.RATE_LIMIT,
  };
  process.env.ADMIN_TOKEN = "admin-secret";
  process.env.AUTH_USERS_JSON = JSON.stringify([
    { id: "redaccion", token: "editor-secret", roles: ["editor"], permissions: [] },
    { id: "auditoria", token: "auditor-secret", roles: ["auditor"], permissions: [] },
  ]);
  process.env.RATE_LIMIT = "20";
  const app = await createApp(
    new ContentManager(new ContentStore(directory)),
    new PressManager(new PressStore(directory)),
  );
  await withServer(app, async (base) => {
    assert.equal((await fetch(`${base}/api/content`)).status, 401);
    assert.equal((await fetch(`${base}/api/auth/me`)).status, 401);
    const identity = await fetch(`${base}/api/auth/me`, {
      headers: { Authorization: "Bearer editor-secret" },
    });
    assert.equal(identity.status, 200);
    assert.deepEqual((await identity.json()).user.roles, ["editor"]);
    assert.equal((await fetch(`${base}/api/public/directory`)).status, 401);
    assert.equal(
      (await fetch(`${base}/api/content`, { headers: { Authorization: "Bearer auditor-secret" } })).status,
      200,
    );
    assert.equal(
      (
        await fetch(`${base}/api/content`, {
          method: "POST",
          headers: { Authorization: "Bearer auditor-secret", "Content-Type": "application/json" },
          body: JSON.stringify({ title: "No debe crear" }),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${base}/api/content`, {
          headers: { Authorization: "Bearer editor-secret" },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(`${base}/api/ops/status`, {
          headers: { Authorization: "Bearer editor-secret" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${base}/api/press/snapshot`, {
          headers: { Authorization: "Bearer editor-secret" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${base}/api/ops/status`, {
          headers: { "X-API-Key": "admin-secret" },
        })
      ).status,
      200,
    );
    assert.equal((await fetch(`${base}/health`)).headers.get("x-content-type-options"), "nosniff");
  });
  if (previous.admin === undefined) delete process.env.ADMIN_TOKEN;
  else process.env.ADMIN_TOKEN = previous.admin;
  if (previous.users === undefined) delete process.env.AUTH_USERS_JSON;
  else process.env.AUTH_USERS_JSON = previous.users;
  if (previous.rate === undefined) delete process.env.RATE_LIMIT;
  else process.env.RATE_LIMIT = previous.rate;
});

test("rechaza payloads inválidos y protege rutas privadas de prensa", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "medio-under-app-validation-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const oldToken = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = "admin";
  const app = await createApp(
    new ContentManager(new ContentStore(directory)),
    new PressManager(new PressStore(directory)),
  );
  await withServer(app, async (base) => {
    const headers = {
      Authorization: "Bearer admin",
      "Content-Type": "application/json",
    };
    const invalid = await fetch(`${base}/api/content`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "" }),
    });
    assert.equal(invalid.status, 400);
    const privateRoute = await fetch(`${base}/api/press/snapshot`, {
      headers: { Authorization: "Bearer admin" },
    });
    assert.equal(privateRoute.status, 200);
  });
  if (oldToken === undefined) delete process.env.ADMIN_TOKEN;
  else process.env.ADMIN_TOKEN = oldToken;
});

test("permite buscar reemplazo para una cobertura cuando el fotógrafo o notero no puede asistir", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "medio-under-replacement-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const manager = new ContentManager(new ContentStore(directory));
  const oldToken = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = "community-test-admin";
  const app = await createApp(manager, new PressManager(new PressStore(directory)));
  await withServer(app, async (base) => {
    const response = await fetch(`${base}/api/public/submissions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer community-test-admin" },
      body: JSON.stringify({
        kind: "Reemplazo de fotógrafo",
        title: "Buscamos fotógrafa para cubrir recital",
        description:
          "No voy a poder asistir a la fecha del sábado. Busco una fotógrafa o fotógrafo con experiencia en recitales, cámara propia y disponibilidad para entregar una selección de fotos.",
        contact: "redaccion@example.com",
      }),
    });
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.equal(result.accepted, true);
    const stored = await manager.required(result.id);
    assert.equal(stored.status, "approved");
    assert.equal(stored.channels.includes("website"), true);
    assert.match(stored.title, /fotógrafa/i);
    assert.match(stored.notes, /Reemplazo de fotógrafo/);
    assert.match(stored.notes, /redaccion@example.com/);
    assert.equal((await manager.store.list("published")).length, 0);
  });
  if (oldToken === undefined) delete process.env.ADMIN_TOKEN;
  else process.env.ADMIN_TOKEN = oldToken;
});

test("expone y protege las métricas de Instagram", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "medio-under-app-instagram-metrics-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const manager = new ContentManager(new ContentStore(directory));
  const item = await manager.create({ title: "Post con métricas", channels: ["instagram"] });
  await manager.store.update(item.id, { remoteIds: { instagram: "media-1" } });
  const oldAdmin = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = "metrics-admin";
  const app = await createApp(manager, new PressManager(new PressStore(directory)));
  try {
    await withServer(app, async (base) => {
      assert.equal((await fetch(`${base}/api/metrics/instagram`)).status, 401);
      const refresh = await fetch(`${base}/api/content/${item.id}/metrics/instagram`, {
        method: "POST",
        headers: { Authorization: "Bearer metrics-admin", "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun: true }),
      });
      assert.equal(refresh.status, 200);
      const refreshed = await refresh.json();
      assert.equal(refreshed.instagramMetrics.totalInteractions, 0);
      const summary = await fetch(`${base}/api/metrics/instagram`, {
        headers: { Authorization: "Bearer metrics-admin" },
      });
      assert.equal(summary.status, 200);
      const data = await summary.json();
      assert.equal(data.posts, 1);
      assert.equal(data.totals.reach, 0);
      assert.equal(
        (
          await fetch(`${base}/api/content/${item.id}/metrics/instagram`, {
            method: "POST",
            headers: { Authorization: "Bearer metrics-admin", "Content-Type": "application/json" },
            body: JSON.stringify({ dryRun: true }),
          })
        ).status,
        200,
      );
    });
  } finally {
    if (oldAdmin === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = oldAdmin;
  }
});

test("limita Instagram por permiso aunque el usuario tenga rol editorial", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "medio-under-app-instagram-permissions-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const oldUsers = process.env.AUTH_USERS_JSON;
  const oldSecret = process.env.JWT_SECRET;
  delete process.env.JWT_SECRET;
  process.env.AUTH_USERS_JSON = JSON.stringify([
    { id: "editor", token: "editor-token", roles: ["editor"], permissions: [] },
    {
      id: "social",
      token: "social-token",
      roles: ["editor", "social"],
      permissions: ["instagram:metrics"],
    },
  ]);
  const app = await createApp(
    new ContentManager(new ContentStore(directory)),
    new PressManager(new PressStore(directory)),
  );
  try {
    await withServer(app, async (base) => {
      assert.equal(
        (await fetch(`${base}/api/metrics/instagram`, { headers: { Authorization: "Bearer editor-token" } })).status,
        403,
      );
      assert.equal(
        (await fetch(`${base}/api/metrics/instagram`, { headers: { Authorization: "Bearer social-token" } })).status,
        200,
      );
    });
  } finally {
    if (oldUsers === undefined) delete process.env.AUTH_USERS_JSON;
    else process.env.AUTH_USERS_JSON = oldUsers;
    if (oldSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = oldSecret;
  }
});

test("permite previsualizar duplicados y rechaza guardar una coincidencia fuerte", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "medio-under-app-duplicates-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const manager = new ContentManager(new ContentStore(directory));
  await manager.create({ title: "Festival repetido", body: "Cobertura completa del festival." });
  const oldAdmin = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = "duplicates-admin";
  const app = await createApp(manager, new PressManager(new PressStore(directory)));
  try {
    await withServer(app, async (base) => {
      const preview = await fetch(`${base}/api/content/duplicates`, {
        method: "POST",
        headers: { Authorization: "Bearer duplicates-admin", "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Festival repetido", body: "Otra versión." }),
      });
      assert.equal(preview.status, 200);
      assert.equal((await preview.json()).length, 1);
      const duplicate = await fetch(`${base}/api/content`, {
        method: "POST",
        headers: { Authorization: "Bearer duplicates-admin", "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Festival repetido", body: "Cobertura completa del festival." }),
      });
      assert.equal(duplicate.status, 409);
    });
  } finally {
    if (oldAdmin === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = oldAdmin;
  }
});
