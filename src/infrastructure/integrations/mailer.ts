import nodemailer, { type Transporter } from "nodemailer";

export type Mail = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  fromName?: string;
};

export class PressMailer {
  private transporter?: Transporter;

  private getTransporter(): Transporter {
    if (this.transporter) return this.transporter;
    const host = process.env.SMTP_HOST;
    const port = Number(process.env.SMTP_PORT ?? 587);
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    if (!host || !user || !pass)
      throw new Error("SMTP_HOST, SMTP_USER y SMTP_PASS son necesarios para enviar solicitudes");
    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure: process.env.SMTP_SECURE === "true",
      auth: { user, pass },
    });
    return this.transporter;
  }

  async send(mail: Mail, dryRun = false): Promise<{ messageId: string; dryRun: boolean }> {
    if (dryRun) return { messageId: `dry-run-${Date.now()}`, dryRun: true };
    const address = process.env.SMTP_FROM ?? process.env.SMTP_USER;
    if (!address) throw new Error("SMTP_FROM o SMTP_USER es necesario para enviar solicitudes");
    const from = mail.fromName ? `"${mail.fromName.replace(/[\"\r\n]/g, "")}" <${address}>` : address;
    const { fromName: _fromName, ...payload } = mail;
    const result = await this.getTransporter().sendMail({
      from,
      ...payload,
      headers: { "X-Mailer": "Medio Under Press Desk" },
    });
    return { messageId: result.messageId, dryRun: false };
  }
}
