import { PressMailer, type Mail } from "../infrastructure/integrations/mailer.js";
import type { MailReplyInput, MailThread, MailThreadSummary } from "../domain/mail/types.js";
import type { MailRepository } from "../infrastructure/persistence/mail-store.js";

export class MailboxManager {
  constructor(
    private readonly repository: MailRepository,
    private readonly mailer: Pick<PressMailer, "send"> = new PressMailer(),
  ) {}

  listThreads(): Promise<MailThreadSummary[]> {
    return this.repository.listThreads();
  }

  getThread(id: string): Promise<MailThread | undefined> {
    return this.repository.getThread(id);
  }

  markRead(id: string): Promise<void> {
    return this.repository.markRead(id);
  }

  async reply(id: string, input: MailReplyInput) {
    const thread = await this.repository.getThread(id);
    if (!thread) throw new Error("Conversación no encontrada");
    const latestInbound = [...thread.messages].reverse().find((message) => message.direction === "inbound");
    if (!latestInbound) throw new Error("La conversación no tiene un destinatario para responder");
    const domain = (process.env.INBOUND_EMAIL_DOMAIN ?? "afterstage.ar").toLowerCase();
    const replyFrom =
      [latestInbound.deliveredTo, ...latestInbound.to]
        .filter((address): address is string => Boolean(address))
        .map((address) => address.trim().toLowerCase())
        .find((address) => address.endsWith(`@${domain}`)) ??
      process.env.SMTP_FROM ??
      process.env.SMTP_USER ??
      `afterstage@${domain}`;
    const subject = /^re:/i.test(latestInbound.subject)
      ? latestInbound.subject
      : `Re: ${latestInbound.subject || "(sin asunto)"}`;
    const mail: Mail = {
      from: replyFrom,
      to: latestInbound.from,
      subject,
      text: input.text,
      ...(input.html !== undefined ? { html: input.html } : {}),
      ...(latestInbound.messageId ? { inReplyTo: latestInbound.messageId } : {}),
      ...(latestInbound.references.length
        ? { references: [...latestInbound.references, latestInbound.messageId] }
        : {}),
    };
    const result = await this.mailer.send(mail);
    return this.repository.addOutbound({
      threadId: id,
      messageId: result.messageId,
      from: replyFrom,
      to: [latestInbound.from],
      subject,
      text: input.text,
      ...(input.html !== undefined ? { html: input.html } : {}),
      inReplyTo: latestInbound.messageId,
      references: [...latestInbound.references, latestInbound.messageId],
    });
  }
}
