import test from "node:test";
import assert from "node:assert/strict";
import { MailboxManager } from "./mailbox-manager.js";
import type { MailMessage, MailThread, MailThreadSummary } from "../domain/mail/types.js";
import type { MailRepository } from "../infrastructure/persistence/mail-store.js";

const inbound: MailMessage = {
  id: "message-1",
  threadId: "thread-1",
  direction: "inbound",
  messageId: "<incoming@example.com>",
  deliveredTo: "prensa@afterstage.ar",
  references: [],
  from: "persona@example.com",
  to: ["prensa@afterstage.ar"],
  cc: [],
  subject: "Solicitud de prensa",
  text: "Hola, ¿podemos coordinar una entrevista?",
  receivedAt: "2026-10-25T10:00:00.000Z",
  createdAt: "2026-10-25T10:00:00.000Z",
  readAt: null,
};

const thread = (): MailThread => ({
  id: "thread-1",
  subject: inbound.subject,
  participants: [inbound.from, ...inbound.to],
  lastMessageAt: inbound.receivedAt,
  unreadCount: 1,
  createdAt: inbound.createdAt,
  updatedAt: inbound.createdAt,
  messages: [inbound],
});

class FakeMailbox implements MailRepository {
  sent: Parameters<MailRepository["addOutbound"]>[0][] = [];
  async init() {}
  async ingestInbound() {
    return inbound;
  }
  async listThreads(): Promise<MailThreadSummary[]> {
    return [];
  }
  async getThread() {
    return thread();
  }
  async markRead() {}
  async addOutbound(input: Parameters<MailRepository["addOutbound"]>[0]) {
    this.sent.push(input);
    return {
      ...inbound,
      id: "message-2",
      direction: "outbound" as const,
      messageId: input.messageId,
      from: input.from,
      to: input.to,
      subject: input.subject,
      text: input.text,
      receivedAt: "2026-10-25T10:01:00.000Z",
      createdAt: "2026-10-25T10:01:00.000Z",
      readAt: "2026-10-25T10:01:00.000Z",
    };
  }
}

test("responde al último remitente y persiste la salida", async () => {
  const repository = new FakeMailbox();
  const mailer = {
    send: async (mail: { from?: string; to: string; subject: string; text: string }) => {
      assert.equal(mail.from, "prensa@afterstage.ar");
      assert.equal(mail.to, "persona@example.com");
      assert.equal(mail.subject, "Re: Solicitud de prensa");
      assert.equal(mail.text, "Sí, coordinemos.");
      return { messageId: "<outgoing@afterstage.ar>", dryRun: false };
    },
  };
  const manager = new MailboxManager(repository, mailer);

  const message = await manager.reply("thread-1", { text: "Sí, coordinemos." });

  assert.equal(message.direction, "outbound");
  assert.deepEqual(repository.sent[0], {
    threadId: "thread-1",
    messageId: "<outgoing@afterstage.ar>",
    from: "prensa@afterstage.ar",
    to: ["persona@example.com"],
    subject: "Re: Solicitud de prensa",
    text: "Sí, coordinemos.",
    inReplyTo: "<incoming@example.com>",
    references: ["<incoming@example.com>"],
  });
});
