import { z } from "zod";

export const mailAddressSchema = z.string().trim().min(3).max(998);

export const inboundMailSchema = z.object({
  messageId: z.string().trim().min(1).max(998).optional(),
  from: mailAddressSchema,
  deliveredTo: mailAddressSchema.optional(),
  to: z.array(mailAddressSchema).min(1).max(50),
  cc: z.array(mailAddressSchema).max(50).default([]),
  subject: z.string().max(998).default(""),
  text: z.string().max(10_000_000).default(""),
  html: z.string().max(10_000_000).optional(),
  receivedAt: z.string().datetime({ offset: true }).optional(),
  inReplyTo: z.string().max(998).optional(),
  references: z.array(z.string().max(998)).max(100).default([]),
});

export const mailReplySchema = z.object({
  text: z.string().trim().min(1).max(10_000_000),
  html: z.string().max(10_000_000).optional(),
});

export type InboundMailInput = z.infer<typeof inboundMailSchema>;
export type MailReplyInput = z.infer<typeof mailReplySchema>;

export type MailMessage = {
  id: string;
  threadId: string;
  direction: "inbound" | "outbound";
  messageId: string;
  deliveredTo?: string;
  inReplyTo?: string;
  references: string[];
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  html?: string;
  receivedAt: string;
  createdAt: string;
  readAt?: string | null;
};

export type MailThread = {
  id: string;
  subject: string;
  mailbox?: string;
  mailboxType?: "personal" | "distribution";
  mailboxLabel?: string;
  participants: string[];
  lastMessageAt: string;
  unreadCount: number;
  createdAt: string;
  updatedAt: string;
  messages: MailMessage[];
};

export type MailThreadSummary = Omit<MailThread, "messages"> & {
  preview: string;
  lastDirection: MailMessage["direction"];
};
