import test from "node:test";
import assert from "node:assert/strict";
import { constants, publicEncrypt } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createApp, insuranceNotificationText } from "./app.js";
import { ContentManager } from "../../application/content-manager.js";
import { MetaPublisher } from "../../infrastructure/integrations/meta.js";
import { ContentStore } from "../../infrastructure/persistence/content-store.js";
import { PressManager } from "../../application/press-manager.js";
import { PressStore } from "../../infrastructure/persistence/press-store.js";
import { DirectoryManager } from "../../application/directory-manager.js";
import { DirectoryStore } from "../../infrastructure/persistence/directory-store.js";
import { configureUserDirectory, getAuthEncryptionPublicKey, issueAccessToken, type ActiveUser } from "./security.js";

const testUsers: Record<string, ActiveUser> = {
  admin: {
    id: "admin",
    roles: ["admin"],
    permissions: ["instagram:read", "instagram:metrics", "instagram:publish"],
    active: true,
  },
  editor: { id: "editor", roles: ["editor"], permissions: [], active: true },
  auditor: { id: "auditor", roles: ["auditor"], permissions: [], active: true },
  social: { id: "social", roles: ["editor", "social"], permissions: ["instagram:metrics"], active: true },
};
process.env.JWT_SECRET = "app-test-secret";
configureUserDirectory({ findActiveUser: async (id) => testUsers[id] });
const testTokens = Object.fromEntries(Object.entries(testUsers).map(([id, user]) => [id, issueAccessToken(user)]));

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

test("arma una solicitud de seguros lista para copiar y pegar por producto", () => {
  const text = insuranceNotificationText({
    name: "Productora Completa",
    dni: "30123456",
    organization: "Productora Completa SRL",
    email: "cotizaciones@example.com",
    phone: "",
    coverageType: "Accidentes personales + ART",
    coverageTypes: ["ap", "art"],
    productDetails: {
      eventName: "Festival de prueba",
      eventLocation: "CABA",
      apPeopleCount: 120,
      apInsuredSumLabel: "$10.000.000",
      artEmployer: "Productora Completa SRL",
      artActivity: "Producción de eventos",
      artWorkerCount: 18,
    },
    startsAt: null,
    endsAt: null,
    peopleCount: 120,
    notes: "Consultar cobertura para montaje y show.",
  });
  assert.match(text, /Asunto sugerido: Solicitud de cotización · Accidentes personales \+ ART/);
  assert.match(text, /\[ACCIDENTES PERSONALES\]/);
  assert.match(text, /\[ART\]/);
  assert.match(text, /DNI: 30123456/);
});

test("rechaza login y registro sin HTTPS y no acepta contraseñas en claro", async (context) => {
  const previous = { nodeEnv: process.env.NODE_ENV, trustProxy: process.env.TRUST_PROXY };
  process.env.NODE_ENV = "production";
  process.env.TRUST_PROXY = "true";
  context.after(() => {
    if (previous.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous.nodeEnv;
    if (previous.trustProxy === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = previous.trustProxy;
  });

  const directory = await mkdtemp(path.join(os.tmpdir(), "afterstage-secure-auth-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const app = await createApp(
    new ContentManager(new ContentStore(directory)),
    new PressManager(new PressStore(directory)),
  );
  const encryptionKey = getAuthEncryptionPublicKey();
  const passwordCiphertext = publicEncrypt(
    {
      key: Buffer.from(encryptionKey.publicKey, "base64url"),
      format: "der",
      type: "spki",
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    Buffer.from("no-se-envia"),
  ).toString("base64url");
  await withServer(app, async (base) => {
    for (const route of ["login", "register"]) {
      const insecure = await fetch(`${base}/api/auth/${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: "redaccion",
          email: "redaccion@example.com",
          passwordCiphertext,
          keyId: encryptionKey.keyId,
        }),
      });
      assert.equal(insecure.status, 400);
      assert.match((await insecure.json()).error, /HTTPS/);

      const cleartext = await fetch(`${base}/api/auth/${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-Proto": "https" },
        body: JSON.stringify({ identifier: "redaccion", email: "redaccion@example.com", password: "no-se-envia" }),
      });
      assert.equal(cleartext.status, 400);

      const encrypted = await fetch(`${base}/api/auth/${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-Proto": "https" },
        body: JSON.stringify({
          identifier: "redaccion",
          email: "redaccion@example.com",
          passwordCiphertext,
          keyId: encryptionKey.keyId,
        }),
      });
      assert.notEqual(encrypted.status, 400);
    }
  });
});

test("expone health, readiness y feed editorial público", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "afterstage-app-public-"));
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
  delete process.env.MONGODB_URI;
  const app = await createApp(manager, new PressManager(new PressStore(directory)));
  await withServer(app, async (base) => {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, "ok");
    assert.equal(health.headers.get("Permissions-Policy"), "camera=(), microphone=(), geolocation=(self)");
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
    assert.match(articleHtml, /Compartir nota/);
    assert.match(articleHtml, /Copiar copy para Instagram/);
    assert.match(articleHtml, /share-bar\{align-items:center/);
    assert.match(articleHtml, /src="\/share-ux-final-20261021\.js"/);
    const submission = await fetch(`${base}/api/public/submissions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${testTokens.admin}` },
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
    const sitemap = await fetch(`${base}/sitemap.xml`);
    assert.equal(sitemap.status, 200);
    const sitemapXml = await sitemap.text();
    assert.match(sitemapXml, /<loc>http:\/\/localhost:8787\/como-funciona<\/loc>/);
    assert.match(sitemapXml, /<loc>http:\/\/localhost:8787\/marketplace<\/loc>/);
    assert.match(sitemapXml, /<loc>http:\/\/localhost:8787\/colaborador<\/loc>/);
    for (const protectedRoute of ["/directorio", "/publicar", "/reemplazos"]) {
      assert.doesNotMatch(sitemapXml, new RegExp(`<loc>http:\/\/localhost:8787${protectedRoute}<\\/loc>`));
    }
    assert.equal((await fetch(`${base}/robots.txt`)).status, 200);
  });
});

test("no publica fixtures demo en las superficies públicas", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "afterstage-demo-filter-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const manager = new ContentManager(new ContentStore(directory));
  const demo = await manager.create({
    title: "DEMO — Nota de prueba",
    source: "seed-demo",
    tags: ["demo"],
    channels: ["website"],
  });
  await manager.update(demo.id, { status: "review" });
  await manager.update(demo.id, { status: "approved" });
  await manager.store.update(demo.id, { status: "published", publishedAt: new Date().toISOString() });
  const press = new PressManager(new PressStore(directory));
  await press.createEvent({
    name: "DEMO — Evento de prueba",
    genres: ["Rock"],
    notes: "Evento ficticio generado para pruebas.",
    startsAt: "2099-01-01T21:00:00.000Z",
  });
  const app = await createApp(manager, press);
  await withServer(app, async (base) => {
    assert.deepEqual(await (await fetch(`${base}/api/public/content`)).json(), []);
    assert.deepEqual(await (await fetch(`${base}/api/public/events`)).json(), []);
    assert.equal((await fetch(`${base}/api/public/content/${demo.slug}`)).status, 404);
    assert.equal((await fetch(`${base}/notas/${demo.slug}`)).status, 404);
  });
});

test("mantiene visible un evento editorial mientras dura su rango de fechas", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "afterstage-multiday-public-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const manager = new ContentManager(new ContentStore(directory));
  const press = new PressManager(new PressStore(directory));
  const event = await press.createEvent({
    name: "Festival en curso",
    genres: ["Rock"],
    startsAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    endsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  const recurringEvent = await press.createEvent({
    name: "Ciclo con fechas sueltas",
    genres: ["Rock"],
    dates: [
      new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
      new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    ],
  });
  const app = await createApp(manager, press, { list: async () => [] });
  await withServer(app, async (base) => {
    const response = await fetch(`${base}/api/public/events`);
    assert.equal(response.status, 200);
    const events = await response.json();
    assert.equal(
      events.some((item: { id: string }) => item.id === event.id),
      true,
    );
    assert.equal(
      events.some((item: { id: string }) => item.id === recurringEvent.id),
      true,
    );
  });
});

test("combina eventos editoriales con fuentes RSS externas", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "afterstage-events-feed-"));
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
    const response = await fetch(`${base}/api/public/events?limit=1`);
    assert.equal(response.status, 200);
    assert.equal((await response.json())[0].name, "Fecha RSS");
  });
});

test("expone el catálogo público sin contactos privados y protege el directorio completo", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "afterstage-directory-api-"));
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
  const app = await createApp(
    manager,
    new PressManager(new PressStore(directory)),
    undefined,
    undefined,
    directoryManager,
  );
  await withServer(app, async (base) => {
    const publicResponse = await fetch(`${base}/api/public/directory?limit=999999`, {
      headers: { Authorization: `Bearer ${testTokens.admin}` },
    });
    const publicItem = (await publicResponse.json())[0];
    assert.equal(publicResponse.status, 200);
    assert.equal(publicItem.name, "Banda API");
    assert.equal(publicItem.contacts, undefined);
    const nearby = await fetch(`${base}/api/public/directory?lat=-34.60&lng=-58.38&radiusKm=5`, {
      headers: { Authorization: `Bearer ${testTokens.admin}` },
    });
    assert.equal((await nearby.json()).length, 1);
    const privateResponse = await fetch(`${base}/api/directory`, {
      headers: { Authorization: `Bearer ${testTokens.admin}` },
    });
    assert.equal(privateResponse.status, 200);
    assert.equal((await privateResponse.json())[0].contacts[0].email, "private@example.com");
    const verification = await fetch(`${base}/api/directory/${publicItem.id}/verification`, {
      method: "POST",
      headers: { Authorization: `Bearer ${testTokens.admin}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "verified", reliabilityScore: 90 }),
    });
    assert.equal(verification.status, 200);
    assert.equal((await verification.json()).reliabilityScore, 90);
  });
});

test("aplica roles, token bearer y rate limit", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "afterstage-app-auth-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const previousRate = process.env.RATE_LIMIT;
  process.env.RATE_LIMIT = "20";
  const app = await createApp(
    new ContentManager(new ContentStore(directory)),
    new PressManager(new PressStore(directory)),
  );
  await withServer(app, async (base) => {
    assert.equal((await fetch(`${base}/api/content`)).status, 401);
    assert.equal((await fetch(`${base}/api/auth/me`)).status, 401);
    const identity = await fetch(`${base}/api/auth/me`, {
      headers: { Authorization: `Bearer ${testTokens.editor}` },
    });
    assert.equal(identity.status, 200);
    assert.deepEqual((await identity.json()).user.roles, ["editor"]);
    assert.equal((await fetch(`${base}/api/public/directory`)).status, 401);
    assert.equal(
      (await fetch(`${base}/api/content`, { headers: { Authorization: `Bearer ${testTokens.auditor}` } })).status,
      200,
    );
    assert.equal(
      (
        await fetch(`${base}/api/content`, {
          method: "POST",
          headers: { Authorization: `Bearer ${testTokens.auditor}`, "Content-Type": "application/json" },
          body: JSON.stringify({ title: "No debe crear" }),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${base}/api/content`, {
          headers: { Authorization: `Bearer ${testTokens.editor}` },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(`${base}/api/ops/status`, {
          headers: { Authorization: `Bearer ${testTokens.editor}` },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${base}/api/press/snapshot`, {
          headers: { Authorization: `Bearer ${testTokens.editor}` },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${base}/api/ops/status`, {
          headers: { Authorization: `Bearer ${testTokens.admin}` },
        })
      ).status,
      200,
    );
    assert.equal((await fetch(`${base}/health`)).headers.get("x-content-type-options"), "nosniff");
  });
  if (previousRate === undefined) delete process.env.RATE_LIMIT;
  else process.env.RATE_LIMIT = previousRate;
});

test("rechaza payloads inválidos y protege rutas privadas de prensa", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "afterstage-app-validation-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const app = await createApp(
    new ContentManager(new ContentStore(directory)),
    new PressManager(new PressStore(directory)),
  );
  await withServer(app, async (base) => {
    const headers = {
      Authorization: `Bearer ${testTokens.admin}`,
      "Content-Type": "application/json",
    };
    const invalid = await fetch(`${base}/api/content`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "" }),
    });
    assert.equal(invalid.status, 400);
    const privateRoute = await fetch(`${base}/api/press/snapshot`, {
      headers: { Authorization: `Bearer ${testTokens.admin}` },
    });
    assert.equal(privateRoute.status, 200);
  });
});

test("permite buscar reemplazo para una cobertura cuando el fotógrafo o notero no puede asistir", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "afterstage-replacement-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const manager = new ContentManager(new ContentStore(directory));
  const app = await createApp(manager, new PressManager(new PressStore(directory)));
  await withServer(app, async (base) => {
    const response = await fetch(`${base}/api/public/submissions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${testTokens.admin}` },
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
});

test("expone y protege las métricas de Instagram", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "afterstage-app-instagram-metrics-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const manager = new ContentManager(new ContentStore(directory));
  const item = await manager.create({ title: "Post con métricas", channels: ["instagram"] });
  await manager.store.update(item.id, { remoteIds: { instagram: "media-1" } });
  const app = await createApp(manager, new PressManager(new PressStore(directory)));
  await withServer(app, async (base) => {
    assert.equal((await fetch(`${base}/api/metrics/instagram`)).status, 401);
    const refresh = await fetch(`${base}/api/content/${item.id}/metrics/instagram`, {
      method: "POST",
      headers: { Authorization: `Bearer ${testTokens.admin}`, "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun: true }),
    });
    assert.equal(refresh.status, 200);
    const refreshed = await refresh.json();
    assert.equal(refreshed.instagramMetrics.totalInteractions, 0);
    const summary = await fetch(`${base}/api/metrics/instagram`, {
      headers: { Authorization: `Bearer ${testTokens.admin}` },
    });
    assert.equal(summary.status, 200);
    const data = await summary.json();
    assert.equal(data.posts, 1);
    assert.equal(data.totals.reach, 0);
    assert.equal(
      (
        await fetch(`${base}/api/content/${item.id}/metrics/instagram`, {
          method: "POST",
          headers: { Authorization: `Bearer ${testTokens.admin}`, "Content-Type": "application/json" },
          body: JSON.stringify({ dryRun: true }),
        })
      ).status,
      200,
    );
  });
});

test("permite recompartir una nota publicada en Instagram con el permiso correspondiente", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "afterstage-app-instagram-repost-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const calls: any[] = [];
  const publisher = {
    publish: async (item: any) => {
      calls.push(item);
      return { instagram: `media-${calls.length}`, containerId: `container-${calls.length}` };
    },
  } as unknown as MetaPublisher;
  const manager = new ContentManager(new ContentStore(directory), undefined, publisher);
  const item = await manager.create({
    title: "Nota para recompartir",
    summary: "Una bajada",
    body: "El texto completo",
    channels: ["instagram"],
    assets: [{ id: "foto", url: "https://example.com/foto.jpg", altText: "", credit: "" }],
  });
  await manager.update(item.id, { status: "review" });
  await manager.update(item.id, { status: "approved" });
  await manager.publish(item.id);
  const app = await createApp(manager, new PressManager(new PressStore(directory)));

  await withServer(app, async (base) => {
    const response = await fetch(`${base}/api/content/${item.id}/repost/instagram`, {
      method: "POST",
      headers: { Authorization: `Bearer ${testTokens.admin}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.remoteIds.instagram, "media-2");
    assert.deepEqual(calls[1].channels, ["instagram"]);
    assert.equal(
      (
        await fetch(`${base}/api/content/${item.id}/repost/instagram`, {
          method: "POST",
          headers: { Authorization: `Bearer ${testTokens.editor}`, "Content-Type": "application/json" },
          body: JSON.stringify({}),
        })
      ).status,
      403,
    );
  });
});

test("limita Instagram por permiso aunque el usuario tenga rol editorial", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "afterstage-app-instagram-permissions-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const app = await createApp(
    new ContentManager(new ContentStore(directory)),
    new PressManager(new PressStore(directory)),
  );
  await withServer(app, async (base) => {
    assert.equal(
      (await fetch(`${base}/api/metrics/instagram`, { headers: { Authorization: `Bearer ${testTokens.editor}` } }))
        .status,
      403,
    );
    assert.equal(
      (await fetch(`${base}/api/metrics/instagram`, { headers: { Authorization: `Bearer ${testTokens.social}` } }))
        .status,
      200,
    );
  });
});

test("permite previsualizar duplicados y rechaza guardar una coincidencia fuerte", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "afterstage-app-duplicates-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const manager = new ContentManager(new ContentStore(directory));
  await manager.create({ title: "Festival repetido", body: "Cobertura completa del festival." });
  const app = await createApp(manager, new PressManager(new PressStore(directory)));
  await withServer(app, async (base) => {
    const preview = await fetch(`${base}/api/content/duplicates`, {
      method: "POST",
      headers: { Authorization: `Bearer ${testTokens.admin}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Festival repetido", body: "Otra versión." }),
    });
    assert.equal(preview.status, 200);
    assert.equal((await preview.json()).length, 1);
    const duplicate = await fetch(`${base}/api/content`, {
      method: "POST",
      headers: { Authorization: `Bearer ${testTokens.admin}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Festival repetido", body: "Cobertura completa del festival." }),
    });
    assert.equal(duplicate.status, 409);
  });
});

test("guarda una nota redactada por el agente desde el endpoint autenticado", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "afterstage-ai-api-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const manager = new ContentManager(new ContentStore(directory));
  const app = await createApp(manager, new PressManager(new PressStore(directory)));

  await withServer(app, async (base) => {
    const response = await fetch(`${base}/api/content/with-ai`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${testTokens.editor}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: "Nota generada por el agente",
        summary: "Bajada",
        body: "La banda presenta una fecha nueva en la ciudad.",
        tags: ["api"],
      }),
    });
    assert.equal(response.status, 201);
    const note = await response.json();
    assert.equal(note.title, "Nota generada por el agente");
    assert.equal(note.status, "draft");
    assert.equal((await manager.required(note.id)).status, "draft");
  });
});
