import { randomUUID } from "node:crypto";
import type { Collection, Db } from "mongodb";
import type { InboundMailInput, MailMessage, MailThread, MailThreadSummary } from "../../domain/mail/types.js";
import {
  defaultMailRoutes,
  mailRouteInputSchema,
  normalizeRouteAddress,
  type MailRoute,
  type MailRouteInput,
  type MailRoutePatch,
} from "../../domain/mail/routing.js";

type MailDocument = Record<string, unknown> & { _id: string };
type MailRouteDocument = MailRouteInput & { _id: string };
const now = () => new Date().toISOString();
const withoutId = ({ _id: _ignored, ...value }: MailDocument) => value;
const unique = (values: string[]) => [...new Set(values.map((value) => value.trim()).filter(Boolean))];
const normalizeSubject = (subject: string) =>
  subject
    .replace(/^(re|fwd|fw)\s*:\s*/gi, "")
    .trim()
    .toLowerCase();

export interface MailRepository {
  init(): Promise<void>;
  ingestInbound(input: InboundMailInput): Promise<MailMessage>;
  listThreads(): Promise<MailThreadSummary[]>;
  getThread(id: string): Promise<MailThread | undefined>;
  markRead(id: string): Promise<void>;
  listRoutes?(): Promise<MailRoute[]>;
  getRoute?(address: string): Promise<MailRoute | undefined>;
  createRoute?(input: MailRouteInput): Promise<MailRoute>;
  updateRoute?(address: string, patch: MailRoutePatch): Promise<MailRoute | undefined>;
  deleteRoute?(address: string): Promise<boolean>;
  addOutbound(input: {
    threadId: string;
    messageId: string;
    from: string;
    to: string[];
    subject: string;
    text: string;
    html?: string;
    inReplyTo?: string;
    references?: string[];
  }): Promise<MailMessage>;
}

export class MongoMailStore implements MailRepository {
  private readonly threads: Collection<MailDocument>;
  private readonly messages: Collection<MailDocument>;
  private readonly routes: Collection<MailRouteDocument>;

  constructor(db: Db) {
    this.threads = db.collection<MailDocument>("mail_threads");
    this.messages = db.collection<MailDocument>("mail_messages");
    this.routes = db.collection<MailRouteDocument>("mail_routes");
  }

  async init() {
    await Promise.all([
      this.threads.createIndex({ lastMessageAt: -1 }),
      this.threads.createIndex({ subjectKey: 1, participants: 1 }),
      this.messages.createIndex({ messageId: 1 }, { unique: true, sparse: true }),
      this.messages.createIndex({ threadId: 1, receivedAt: 1 }),
      this.messages.createIndex({ references: 1 }),
      this.routes.createIndex({ address: 1 }, { unique: true }),
    ]);
    if ((await this.routes.countDocuments()) === 0) {
      await this.routes.insertMany(
        defaultMailRoutes.map((route) => ({ _id: route.address, ...route })),
        { ordered: true },
      );
    }
  }

  private routeFromDocument(document: MailRouteDocument): MailRoute {
    const { _id: _ignored, ...route } = document;
    return { ...route, id: document._id };
  }

  private async threadForMessage(input: InboundMailInput, messageId: string) {
    const relatedIds = unique([messageId, input.inReplyTo ?? "", ...input.references]);
    if (relatedIds.length) {
      const related = await this.messages.findOne({
        $or: [
          { messageId: { $in: relatedIds } },
          { inReplyTo: { $in: relatedIds } },
          { references: { $in: relatedIds } },
        ],
      });
      if (related) return this.threads.findOne({ _id: String(related.threadId) });
    }
    return this.threads.findOne({
      subjectKey: normalizeSubject(input.subject),
      participants: input.from,
      ...(input.deliveredTo ? { mailbox: input.deliveredTo.toLowerCase() } : {}),
    });
  }

  async ingestInbound(input: InboundMailInput): Promise<MailMessage> {
    const messageId = input.messageId || `afterstage-${randomUUID()}`;
    const duplicate = await this.messages.findOne({ messageId });
    if (duplicate) return withoutId(duplicate) as unknown as MailMessage;

    const receivedAt = input.receivedAt ?? now();
    const existingThread = await this.threadForMessage(input, messageId);
    const threadId = existingThread?._id ?? randomUUID();
    const threadCreatedAt = existingThread?.createdAt ?? receivedAt;
    const message: MailMessage = {
      id: randomUUID(),
      threadId,
      direction: "inbound",
      messageId,
      ...(input.deliveredTo ? { deliveredTo: input.deliveredTo } : {}),
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
      references: unique(input.references),
      from: input.from,
      to: unique(input.to),
      cc: unique(input.cc),
      subject: input.subject,
      text: input.text,
      ...(input.html !== undefined ? { html: input.html } : {}),
      receivedAt,
      createdAt: receivedAt,
      readAt: null,
    };
    const participants = unique([
      ...((existingThread?.participants as string[] | undefined) ?? []),
      input.from,
      ...input.to,
      ...input.cc,
    ]);
    await this.messages.insertOne({ _id: message.id, ...message });
    await this.threads.updateOne(
      { _id: threadId },
      {
        $set: {
          subject: existingThread?.subject || input.subject || "(sin asunto)",
          subjectKey: normalizeSubject(input.subject),
          ...(input.deliveredTo ? { mailbox: input.deliveredTo.toLowerCase() } : {}),
          participants,
          lastMessageAt: receivedAt,
          updatedAt: receivedAt,
          lastMessageId: message.id,
          lastDirection: "inbound",
          preview: input.text || input.subject,
        },
        $setOnInsert: { createdAt: threadCreatedAt },
        $inc: { unreadCount: 1 },
      } as never,
      { upsert: true },
    );
    return message;
  }

  async listThreads(): Promise<MailThreadSummary[]> {
    const threads = await this.threads.find().sort({ lastMessageAt: -1 }).toArray();
    return threads.map((thread) => {
      const value = withoutId(thread) as unknown as MailThreadSummary;
      return { ...value, id: thread._id };
    });
  }

  async getThread(id: string): Promise<MailThread | undefined> {
    const thread = await this.threads.findOne({ _id: id });
    if (!thread) return undefined;
    const messages = await this.messages.find({ threadId: id }).sort({ receivedAt: 1 }).toArray();
    return {
      ...(withoutId(thread) as unknown as Omit<MailThread, "messages">),
      id: thread._id,
      messages: messages.map((message) => withoutId(message) as unknown as MailMessage),
    };
  }

  async markRead(id: string) {
    const readAt = now();
    await Promise.all([
      this.threads.updateOne({ _id: id }, { $set: { unreadCount: 0, updatedAt: readAt } }),
      this.messages.updateMany({ threadId: id, direction: "inbound", readAt: null }, { $set: { readAt } }),
    ]);
  }

  async listRoutes(): Promise<MailRoute[]> {
    const routes = await this.routes.find().sort({ kind: 1, label: 1 }).toArray();
    return routes.map((route) => this.routeFromDocument(route));
  }

  async getRoute(address: string): Promise<MailRoute | undefined> {
    const route = await this.routes.findOne({ _id: normalizeRouteAddress(address) });
    return route ? this.routeFromDocument(route) : undefined;
  }

  async createRoute(input: MailRouteInput): Promise<MailRoute> {
    const parsed = mailRouteInputSchema.parse(input);
    const route = { ...parsed, address: normalizeRouteAddress(parsed.address) };
    await this.routes.insertOne({ _id: route.address, ...route });
    return { ...route, id: route.address };
  }

  async updateRoute(address: string, patch: MailRoutePatch): Promise<MailRoute | undefined> {
    const current = await this.getRoute(address);
    if (!current) return undefined;
    const values = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    ) as MailRoutePatch;
    const next = mailRouteInputSchema.parse({
      address: current.address,
      label: values.label ?? current.label,
      kind: values.kind ?? current.kind,
      destinations: values.destinations ?? current.destinations,
    });
    await this.routes.updateOne({ _id: current.address }, { $set: next });
    return { ...next, id: current.id };
  }

  async deleteRoute(address: string): Promise<boolean> {
    return (await this.routes.deleteOne({ _id: normalizeRouteAddress(address) })).deletedCount === 1;
  }

  async addOutbound(input: {
    threadId: string;
    messageId: string;
    from: string;
    to: string[];
    subject: string;
    text: string;
    html?: string;
    inReplyTo?: string;
    references?: string[];
  }): Promise<MailMessage> {
    const sentAt = now();
    const message: MailMessage = {
      id: randomUUID(),
      threadId: input.threadId,
      direction: "outbound",
      messageId: input.messageId,
      ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
      references: unique(input.references ?? []),
      from: input.from,
      to: unique(input.to),
      cc: [],
      subject: input.subject,
      text: input.text,
      ...(input.html !== undefined ? { html: input.html } : {}),
      receivedAt: sentAt,
      createdAt: sentAt,
      readAt: sentAt,
    };
    await this.messages.insertOne({ _id: message.id, ...message });
    await this.threads.updateOne({ _id: input.threadId }, {
      $set: {
        subject: input.subject,
        subjectKey: normalizeSubject(input.subject),
        lastMessageAt: sentAt,
        updatedAt: sentAt,
        lastMessageId: message.id,
        lastDirection: "outbound",
        preview: input.text || input.subject,
      },
      $addToSet: { participants: { $each: [input.from, ...input.to] } },
    } as never);
    return message;
  }
}
