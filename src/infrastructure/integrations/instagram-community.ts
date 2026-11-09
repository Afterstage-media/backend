import type { InstagramTrustedCollaboratorStore } from "../persistence/instagram-trusted-collaborators.js";

type GraphObject = Record<string, unknown>;
type GraphPage = { data?: GraphObject[]; paging?: { next?: string } };

const apiBase = () => `https://graph.facebook.com/${process.env.META_API_VERSION ?? "v24.0"}`;
const accessToken = () => {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) throw new Error("META_ACCESS_TOKEN no está configurada");
  return token;
};

const graphRequest = async (path: string, method: "GET" | "POST", fields: Record<string, string> = {}) => {
  const url = new URL(`${apiBase()}/${path.replace(/^\//, "")}`);
  const token = accessToken();
  if (method === "GET") {
    url.searchParams.set("access_token", token);
    for (const [key, value] of Object.entries(fields)) url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    method,
    ...(method === "POST"
      ? {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ ...fields, access_token: token }),
        }
      : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const result = (await response.json()) as GraphObject;
  const error = result.error as { message?: string; code?: number } | undefined;
  if (!response.ok || error)
    throw new Error(`Instagram API ${error?.code ?? response.status}: ${error?.message ?? "error desconocido"}`);
  return result;
};

export class InstagramCommunity {
  constructor(private readonly collaborators: InstagramTrustedCollaboratorStore) {}

  private accountId(): string {
    const value = process.env.META_INSTAGRAM_ACCOUNT_ID;
    if (!value) throw new Error("META_INSTAGRAM_ACCOUNT_ID no está configurada");
    return value;
  }

  async listConversations(limit = 25): Promise<GraphObject[]> {
    const result = (await graphRequest(`${this.accountId()}/conversations`, "GET", {
      platform: "instagram",
      fields: "id,updated_time,participants",
      limit: String(limit),
    })) as GraphPage;
    return result.data ?? [];
  }

  async listMessages(conversationId: string, limit = 50): Promise<GraphObject[]> {
    const result = (await graphRequest(`${encodeURIComponent(conversationId)}/messages`, "GET", {
      fields: "id,created_time,from,to,message,attachments",
      limit: String(limit),
    })) as GraphPage;
    return result.data ?? [];
  }

  async sendMessage(recipientId: string, message: string): Promise<GraphObject> {
    if (!recipientId.trim()) throw new Error("Falta el identificador del destinatario");
    const result = await graphRequest(`${this.accountId()}/messages`, "POST", {
      recipient: JSON.stringify({ id: recipientId }),
      message: JSON.stringify({ text: message }),
    });
    return { recipientId, messageId: result.message_id ?? result.id ?? null };
  }

  async listComments(mediaId: string, limit = 100): Promise<GraphObject[]> {
    const result = (await graphRequest(`${encodeURIComponent(mediaId)}/comments`, "GET", {
      fields: "id,text,username,timestamp,like_count,replies",
      limit: String(limit),
    })) as GraphPage;
    return result.data ?? [];
  }

  async replyToComment(commentId: string, message: string): Promise<GraphObject> {
    const result = await graphRequest(`${encodeURIComponent(commentId)}/replies`, "POST", { message });
    return { commentId, replyId: result.id ?? null };
  }

  async acceptTrustedCollaborationInvites(): Promise<{
    checked: number;
    accepted: Array<{ username: string; mediaId: string }>;
  }> {
    const trusted = new Set((await this.collaborators.list()).map((item) => item.username.toLowerCase()));
    if (!trusted.size) return { checked: 0, accepted: [] };
    const accountId = this.accountId();
    const result = (await graphRequest(`${accountId}/collaboration_invites`, "GET", {
      fields: "media_id,media_owner_username,caption,media_url",
      limit: "100",
    })) as GraphPage;
    const invites = result.data ?? [];
    const accepted: Array<{ username: string; mediaId: string }> = [];
    for (const invite of invites) {
      const username = String(invite.media_owner_username ?? "")
        .replace(/^@/, "")
        .toLowerCase();
      const mediaId = String(invite.media_id ?? invite.id ?? "");
      if (!mediaId || !trusted.has(username)) continue;
      await graphRequest(`${accountId}/collaboration_invites`, "POST", { media_id: mediaId, accept: "true" });
      accepted.push({ username, mediaId });
    }
    return { checked: invites.length, accepted };
  }
}
