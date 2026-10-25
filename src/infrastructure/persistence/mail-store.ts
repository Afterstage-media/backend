import { randomUUID } from "node:crypto";
import type { Collection, Db } from "mongodb";
import type { InboundMailInput, MailMessage, MailThread, MailThreadSummary } from "../../domain/mail/types.js";

type MailDocument = Record<string, unknown> & { _id: string };
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

  constructor(db: Db) {
    this.threads = db.collection<MailDocument>("mail_threads");
    this.messages = db.collection<MailDocument>("mail_messages");
  }

  async init() {
    await Promise.all([
      this.threads.createIndex({ lastMessageAt: -1 }),
      this.threads.createIndex({ subjectKey: 1, participants: 1 }),
      this.messages.createIndex({ messageId: 1 }, { unique: true, sparse: true }),
      this.messages.createIndex({ threadId: 1, receivedAt: 1 }),
      this.messages.createIndex({ references: 1 }),
    ]);
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
      return value;
    });
  }

  async getThread(id: string): Promise<MailThread | undefined> {
    const thread = await this.threads.findOne({ _id: id });
    if (!thread) return undefined;
    const messages = await this.messages.find({ threadId: id }).sort({ receivedAt: 1 }).toArray();
    return {
      ...(withoutId(thread) as unknown as Omit<MailThread, "messages">),
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
