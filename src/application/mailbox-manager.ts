import { PressMailer, type Mail } from "../infrastructure/integrations/mailer.js";
import type { MailReplyInput, MailThread, MailThreadSummary } from "../domain/mail/types.js";
import {
  defaultMailRoutes,
  normalizeRouteAddress,
  type MailRoute,
  type MailRouteInput,
  type MailRoutePatch,
} from "../domain/mail/routing.js";
import type { MailRepository } from "../infrastructure/persistence/mail-store.js";

export class MailboxManager {
  constructor(
    private readonly repository: MailRepository,
    private readonly mailer: Pick<PressMailer, "send"> = new PressMailer(),
  ) {}

  async listThreads(): Promise<MailThreadSummary[]> {
    const [threads, routes] = await Promise.all([this.repository.listThreads(), this.listRoutes()]);
    const routeByAddress = new Map(routes.map((route) => [route.address, route]));
    return threads.map((thread) => this.withRouteMetadata(thread, routeByAddress));
  }

  async getThread(id: string): Promise<MailThread | undefined> {
    const thread = await this.repository.getThread(id);
    if (!thread) return undefined;
    const route = thread.mailbox ? await this.getRoute(thread.mailbox) : undefined;
    return this.withRouteMetadata(thread, route ? new Map([[route.address, route]]) : new Map());
  }

  async listRoutes(): Promise<MailRoute[]> {
    return this.repository.listRoutes
      ? this.repository.listRoutes()
      : defaultMailRoutes.map((route) => ({ ...route, id: route.address }));
  }

  async getRoute(address: string): Promise<MailRoute | undefined> {
    const normalized = normalizeRouteAddress(address);
    if (this.repository.getRoute) return this.repository.getRoute(normalized);
    const route = defaultMailRoutes.find((item) => item.address === normalized);
    return route ? { ...route, id: route.address } : undefined;
  }

  createRoute(input: MailRouteInput): Promise<MailRoute> {
    if (!this.repository.createRoute) throw new Error("La gestión de rutas de correo no está disponible");
    return this.repository.createRoute(input);
  }

  updateRoute(address: string, patch: MailRoutePatch): Promise<MailRoute | undefined> {
    if (!this.repository.updateRoute) throw new Error("La gestión de rutas de correo no está disponible");
    return this.repository.updateRoute(normalizeRouteAddress(address), patch);
  }

  deleteRoute(address: string): Promise<boolean> {
    if (!this.repository.deleteRoute) throw new Error("La gestión de rutas de correo no está disponible");
    return this.repository.deleteRoute(normalizeRouteAddress(address));
  }

  private withRouteMetadata<T extends MailThreadSummary | MailThread>(
    thread: T,
    routeByAddress: Map<string, MailRoute>,
  ): T {
    const route = thread.mailbox ? routeByAddress.get(normalizeRouteAddress(thread.mailbox)) : undefined;
    return {
      ...thread,
      mailboxType: route?.kind ?? "personal",
      mailboxLabel: route?.label ?? thread.mailbox ?? "Dirección personal",
    } as T;
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
