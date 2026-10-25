import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { ContentManager } from "../../application/content-manager.js";
import { PressManager } from "../../application/press-manager.js";
import type { MailMessage, MailThread, MailThreadSummary } from "../../domain/mail/types.js";
import type { MailRepository } from "../../infrastructure/persistence/mail-store.js";
import { createApp } from "./app.js";

class FakeMailbox implements MailRepository {
  received: unknown[] = [];
  async init() {}
  async ingestInbound(input: unknown) {
    this.received.push(input);
    return {
      ...(input as object),
      id: "message-1",
      threadId: "thread-1",
      direction: "inbound" as const,
      messageId: "<incoming@example.com>",
      references: [],
      cc: [],
      receivedAt: "2026-10-25T10:00:00.000Z",
      createdAt: "2026-10-25T10:00:00.000Z",
      readAt: null,
    } as unknown as MailMessage;
  }
  async listThreads(): Promise<MailThreadSummary[]> {
    return [];
  }
  async getThread(): Promise<MailThread | undefined> {
    return undefined;
  }
  async markRead() {}
  async addOutbound(_input: Parameters<MailRepository["addOutbound"]>[0]): Promise<MailMessage> {
    throw new Error("not used");
  }
}

const withServer = async (app: Awaited<ReturnType<typeof createApp>>, run: (base: string) => Promise<void>) => {
  const server = await new Promise<import("node:http").Server>((resolve) => {
    const value = app.listen(0, () => resolve(value));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No se pudo abrir el servidor");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
};

test("acepta el webhook firmado y rechaza firmas inválidas", async (context) => {
  const secret = "test-inbound-secret";
  process.env.INBOUND_EMAIL_WEBHOOK_SECRET = secret;
  context.after(() => delete process.env.INBOUND_EMAIL_WEBHOOK_SECRET);
  const mailbox = new FakeMailbox();
  const app = await createApp(
    new ContentManager(),
    new PressManager(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    mailbox,
  );
  const body = JSON.stringify({
    messageId: "<incoming@example.com>",
    from: "persona@example.com",
    deliveredTo: "prensa@afterstage.ar",
    to: ["prensa@afterstage.ar"],
    subject: "Hola",
    text: "Mensaje recibido",
    receivedAt: "2026-10-25T10:00:00.000Z",
  });
  const signature = createHmac("sha256", secret).update(body).digest("hex");

  await withServer(app, async (base) => {
    const accepted = await fetch(`${base}/api/inbound/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Afterstage-Signature": `sha256=${signature}` },
      body,
    });
    assert.equal(accepted.status, 202);
    assert.equal(mailbox.received.length, 1);

    const rejected = await fetch(`${base}/api/inbound/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Afterstage-Signature": "sha256=00" },
      body,
    });
    assert.equal(rejected.status, 401);

    const route = await fetch(
      `${base}/api/inbound/email/routing?recipient=${encodeURIComponent("prensa@afterstage.ar")}`,
      { headers: { "X-Afterstage-Routing-Secret": secret } },
    );
    assert.equal(route.status, 200);
    assert.equal((await route.json()).route.kind, "distribution");

    const unauthorizedRoute = await fetch(`${base}/api/inbound/email/routing?recipient=prensa@afterstage.ar`);
    assert.equal(unauthorizedRoute.status, 401);
  });
});
