import type { InstagramConnectionStore } from "../persistence/instagram-connections.js";
import type { InstagramTrustedCollaboratorStore } from "../persistence/instagram-trusted-collaborators.js";

type GraphObject = Record<string, unknown>;
type GraphPage = { data?: GraphObject[]; paging?: { next?: string } };
type Credentials = { accountId: string; token: string; base: string };

const graphRequest = async (
  credentials: Credentials,
  path: string,
  method: "GET" | "POST",
  fields: Record<string, string> = {},
) => {
  const url = new URL(`${credentials.base}/${path.replace(/^\//, "")}`);
  if (method === "GET") {
    url.searchParams.set("access_token", credentials.token);
    for (const [key, value] of Object.entries(fields)) url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    method,
    ...(method === "POST"
      ? {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ ...fields, access_token: credentials.token }),
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

const apiVersion = () => process.env.META_API_VERSION ?? "v24.0";

export class InstagramCommunity {
  constructor(
    private readonly collaborators: InstagramTrustedCollaboratorStore,
    private readonly connections?: InstagramConnectionStore,
  ) {}

  private async instagramCredentials(): Promise<Credentials> {
    const connection = await this.connections?.getDefault();
    if (connection) {
      return {
        accountId: connection.accountId,
        token: connection.accessToken,
        base: `https://graph.${connection.apiHost ?? "instagram"}.com/${apiVersion()}`,
      };
    }
    const token = process.env.META_ACCESS_TOKEN;
    const accountId = process.env.META_INSTAGRAM_ACCOUNT_ID;
    if (!token || !accountId) throw new Error("Conectá una cuenta profesional de Instagram en Afterstage");
    return { accountId, token, base: `https://graph.facebook.com/${apiVersion()}` };
  }

  private async facebookCredentials(): Promise<Credentials> {
    const connection = await this.connections?.getDefault();
    if (connection?.apiHost === "facebook")
      return {
        accountId: connection.accountId,
        token: connection.accessToken,
        base: `https://graph.facebook.com/${apiVersion()}`,
      };
    const token = process.env.META_ACCESS_TOKEN;
    const accountId = process.env.META_INSTAGRAM_ACCOUNT_ID;
    if (!token || !accountId)
      throw new Error("La gestión de colaboraciones requiere Instagram conectado mediante Facebook Login");
    return { accountId, token, base: `https://graph.facebook.com/${apiVersion()}` };
  }

  async listConversations(limit = 25): Promise<GraphObject[]> {
    const credentials = await this.instagramCredentials();
    const result = (await graphRequest(credentials, `${credentials.accountId}/conversations`, "GET", {
      platform: "instagram",
      fields: "id,updated_time,participants",
      limit: String(limit),
    })) as GraphPage;
    return result.data ?? [];
  }

  async listMessages(conversationId: string, limit = 50): Promise<GraphObject[]> {
    const credentials = await this.instagramCredentials();
    const result = (await graphRequest(credentials, `${encodeURIComponent(conversationId)}/messages`, "GET", {
      fields: "id,created_time,from,to,message,attachments",
      limit: String(limit),
    })) as GraphPage;
    return result.data ?? [];
  }

  async sendMessage(recipientId: string, message: string): Promise<GraphObject> {
    if (!recipientId.trim()) throw new Error("Falta el identificador del destinatario");
    const credentials = await this.instagramCredentials();
    const result = await graphRequest(credentials, `${credentials.accountId}/messages`, "POST", {
      recipient: JSON.stringify({ id: recipientId }),
      message: JSON.stringify({ text: message }),
    });
    return { recipientId, messageId: result.message_id ?? result.id ?? null };
  }

  async listComments(mediaId: string, limit = 100): Promise<GraphObject[]> {
    const credentials = await this.instagramCredentials();
    const result = (await graphRequest(credentials, `${encodeURIComponent(mediaId)}/comments`, "GET", {
      fields: "id,text,username,timestamp,like_count,replies",
      limit: String(limit),
    })) as GraphPage;
    return result.data ?? [];
  }

  async replyToComment(commentId: string, message: string): Promise<GraphObject> {
    const credentials = await this.instagramCredentials();
    const result = await graphRequest(credentials, `${encodeURIComponent(commentId)}/replies`, "POST", { message });
    return { commentId, replyId: result.id ?? null };
  }

  async acceptTrustedCollaborationInvites(): Promise<{
    checked: number;
    accepted: Array<{ username: string; mediaId: string }>;
  }> {
    const trusted = new Set((await this.collaborators.list()).map((item) => item.username.toLowerCase()));
    if (!trusted.size) return { checked: 0, accepted: [] };
    const credentials = await this.facebookCredentials();
    const accountId = credentials.accountId;
    const result = (await graphRequest(credentials, `${accountId}/collaboration_invites`, "GET", {
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
      await graphRequest(credentials, `${accountId}/collaboration_invites`, "POST", {
        media_id: mediaId,
        accept: "true",
      });
      accepted.push({ username, mediaId });
    }
    return { checked: invites.length, accepted };
  }
}
