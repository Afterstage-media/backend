import test from "node:test";
import assert from "node:assert/strict";
import type { Db } from "mongodb";
import { MongoMailStore } from "./mail-store.js";

const thread = {
  _id: "thread-1",
  subject: "test",
  participants: ["persona@example.com", "federico.markowicz@afterstage.ar"],
  lastMessageAt: "2026-10-25T10:00:00.000Z",
  unreadCount: 1,
  createdAt: "2026-10-25T10:00:00.000Z",
  updatedAt: "2026-10-25T10:00:00.000Z",
  preview: "Mensaje recibido",
  lastDirection: "inbound",
};

const message = {
  _id: "message-1",
  id: "message-1",
  threadId: "thread-1",
  direction: "inbound",
  messageId: "<incoming@example.com>",
  from: "persona@example.com",
  to: ["federico.markowicz@afterstage.ar"],
  cc: [],
  subject: "test",
  text: "Mensaje recibido",
  references: [],
  receivedAt: "2026-10-25T10:00:00.000Z",
  createdAt: "2026-10-25T10:00:00.000Z",
  readAt: null,
};

const cursor = (items: unknown[]) => ({
  sort: () => ({ toArray: async () => items }),
});

test("expone el id del hilo al listar y consultar conversaciones", async () => {
  const collections = {
    mail_threads: {
      find: () => cursor([thread]),
      findOne: async () => thread,
    },
    mail_messages: {
      find: () => cursor([message]),
    },
    mail_routes: {
      find: () =>
        cursor([
          {
            _id: "prensa@afterstage.ar",
            address: "prensa@afterstage.ar",
            label: "Prensa",
            kind: "distribution",
            destinations: ["fede.markoo@gmail.com", "carlajmagnol@gmail.com"],
          },
        ]),
    },
  };
  const db = { collection: (name: keyof typeof collections) => collections[name] } as unknown as Db;
  const store = new MongoMailStore(db);

  const summaries = await store.listThreads();
  assert.equal(summaries[0]?.id, "thread-1");

  const loaded = await store.getThread("thread-1");
  assert.equal(loaded?.id, "thread-1");
  assert.equal(loaded?.messages[0]?.id, "message-1");

  const routes = await store.listRoutes();
  assert.equal(routes[0]?.id, "prensa@afterstage.ar");
  assert.equal(routes[0]?.kind, "distribution");
});
