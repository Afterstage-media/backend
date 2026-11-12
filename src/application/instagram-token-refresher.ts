import type { InstagramConnectionStore } from "../infrastructure/persistence/instagram-connections.js";

const refreshWindowMs = 7 * 24 * 60 * 60 * 1000;

/** Renews an unexpired Instagram Login token before the daily publisher loses access. */
export const refreshInstagramLoginToken = async (
  connections: InstagramConnectionStore,
  now = new Date(),
): Promise<boolean> => {
  const connection = await connections.getDefault();
  if (!connection || connection.apiHost !== "instagram" || !connection.expiresAt) return false;
  if (Date.parse(connection.expiresAt) - now.getTime() > refreshWindowMs) return false;

  const url = new URL("https://graph.instagram.com/refresh_access_token");
  url.searchParams.set("grant_type", "ig_refresh_token");
  url.searchParams.set("access_token", connection.accessToken);
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  const result = (await response.json()) as { access_token?: unknown; expires_in?: unknown; error?: unknown };
  if (!response.ok || typeof result.access_token !== "string" || typeof result.expires_in !== "number") {
    throw new Error(
      "Meta no pudo renovar el token de Instagram; hay que revisar la conexión antes de la próxima publicación",
    );
  }
  const expiresAt = new Date(now.getTime() + result.expires_in * 1000).toISOString();
  await connections.updateAccessToken(connection.accountId, result.access_token, expiresAt);
  return true;
};
