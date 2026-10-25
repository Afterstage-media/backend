import PostalMime from "postal-mime";

interface Env {
  AFTERSTAGE_API_URL: string;
  INBOUND_EMAIL_WEBHOOK_SECRET: string;
}

type Address = { address?: string; name?: string } | string;

const asAddress = (value: Address | undefined | null): string => {
  if (!value) return "";
  if (typeof value === "string") return value;
  return value.name ? `${value.name} <${value.address ?? ""}>`.trim() : (value.address ?? "");
};

const asAddresses = (value: Address | Address[] | undefined | null): string[] =>
  (Array.isArray(value) ? value : value ? [value] : []).map(asAddress).filter(Boolean);

const sign = async (body: string, secret: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const raw = await new Response(message.raw).arrayBuffer();
    const parsed = await PostalMime.parse(raw);
    const payload = JSON.stringify({
      messageId: parsed.messageId || message.headers.get("message-id") || undefined,
      from: asAddress(parsed.from) || message.from,
      deliveredTo: message.to,
      to: [message.to, ...asAddresses(parsed.to)],
      cc: asAddresses(parsed.cc),
      subject: parsed.subject || message.headers.get("subject") || "",
      text: parsed.text || "",
      html: parsed.html || undefined,
      receivedAt: new Date().toISOString(),
      inReplyTo: parsed.inReplyTo || message.headers.get("in-reply-to") || undefined,
      references: parsed.references || message.headers.get("references")?.split(/\s+/).filter(Boolean) || [],
    });
    const signature = await sign(payload, env.INBOUND_EMAIL_WEBHOOK_SECRET);
    const response = await fetch(`${env.AFTERSTAGE_API_URL.replace(/\/$/, "")}/api/inbound/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-afterstage-signature": `sha256=${signature}`,
      },
      body: payload,
    });
    if (!response.ok) {
      message.setReject(`Afterstage rejected the message (${response.status})`);
      throw new Error(`Afterstage inbound endpoint returned ${response.status}`);
    }
  },
};

interface ForwardableEmailMessage {
  from: string;
  to: string;
  headers: Headers;
  raw: ReadableStream;
  setReject(reason: string): void;
}
