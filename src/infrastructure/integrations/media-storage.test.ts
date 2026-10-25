import assert from "node:assert/strict";
import test from "node:test";
import { MediaGatewayClient } from "./media-storage.js";

test("el cliente del gateway envía la reserva Mongo y construye la URL pública", async () => {
  const previous = {
    url: process.env.MEDIA_GATEWAY_URL,
    token: process.env.MEDIA_GATEWAY_SERVICE_TOKEN,
    publicUrl: process.env.MEDIA_PUBLIC_BASE_URL,
    fetch: globalThis.fetch,
  };
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  process.env.MEDIA_GATEWAY_URL = "https://storage.example";
  process.env.MEDIA_GATEWAY_SERVICE_TOKEN = "service-token";
  process.env.MEDIA_PUBLIC_BASE_URL = "https://media.example";
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    return new Response(
      JSON.stringify({
        uploadUrl: "https://storage.example/v1/uploads/grant",
        key: "public/2026-10/note/photo.webp",
        expiresAt: 123,
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  };
  try {
    const client = new MediaGatewayClient();
    const grant = await client.createGrant({
      key: "public/2026-10/note/photo.webp",
      contentType: "image/webp",
      size: 1024,
      quota: {
        reservationId: "mongo-reservation-1",
        totalBytesAfterReservation: 1024,
        monthlyBytesAfterReservation: 1024,
      },
    });
    assert.equal(grant.expiresAt, 123);
    assert.equal(
      client.publicUrl("public/2026-10/note/photo.webp"),
      "https://media.example/media/public/2026-10/note/photo.webp",
    );
    assert.equal(requests[0]?.url, "https://storage.example/v1/upload-grants");
    assert.equal(new Headers(requests[0]?.init?.headers).get("Authorization"), "Bearer service-token");
    assert.match(String(requests[0]?.init?.body), /mongo-reservation-1/);
  } finally {
    if (previous.url === undefined) delete process.env.MEDIA_GATEWAY_URL;
    else process.env.MEDIA_GATEWAY_URL = previous.url;
    if (previous.token === undefined) delete process.env.MEDIA_GATEWAY_SERVICE_TOKEN;
    else process.env.MEDIA_GATEWAY_SERVICE_TOKEN = previous.token;
    if (previous.publicUrl === undefined) delete process.env.MEDIA_PUBLIC_BASE_URL;
    else process.env.MEDIA_PUBLIC_BASE_URL = previous.publicUrl;
    globalThis.fetch = previous.fetch;
  }
});
