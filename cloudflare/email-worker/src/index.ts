import PostalMime from "postal-mime";

interface Env {
  AFTERSTAGE_API_URL: string;
  INBOUND_EMAIL_WEBHOOK_SECRET: string;
  FORWARD_DESTINATIONS?: string;
  DEFAULT_FORWARD_DESTINATIONS?: string;
}

type Address = { address?: string; name?: string } | string;

const asAddress = (value: Address | undefined | null): string => {
  if (!value) return "";
  if (typeof value === "string") return value;
  return value.name ? `${value.name} <${value.address ?? ""}>`.trim() : (value.address ?? "");
};

const asAddresses = (value: Address | Address[] | undefined | null): string[] =>
  (Array.isArray(value) ? value : value ? [value] : []).map(asAddress).filter(Boolean);

const parseDestinations = (value: string | undefined): string[] => {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string" && item.includes("@"))
      : [];
  } catch {
    return [];
  }
};

const destinationsFor = (recipient: string, env: Env): string[] => {
  let mapping: Record<string, unknown> = {};
  try {
    mapping = JSON.parse(env.FORWARD_DESTINATIONS ?? "{}") as Record<string, unknown>;
  } catch {
    mapping = {};
  }
  const configured = mapping[recipient.trim().toLowerCase()];
  return Array.isArray(configured)
    ? configured.filter((item): item is string => typeof item === "string" && item.includes("@"))
    : parseDestinations(env.DEFAULT_FORWARD_DESTINATIONS);
};

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
    const destinations = destinationsFor(message.to, env);
    if (!destinations.length) {
      message.setReject("No forwarding destination configured for this address");
      throw new Error(`No forwarding destination configured for ${message.to}`);
    }
    try {
      await Promise.all(destinations.map((destination) => message.forward(destination)));
    } catch (error) {
      message.setReject("Afterstage could not forward the message");
      throw error;
    }
  },
};

interface ForwardableEmailMessage {
  from: string;
  to: string;
  headers: Headers;
  raw: ReadableStream;
  setReject(reason: string): void;
  forward(destination: string): Promise<void>;
}
