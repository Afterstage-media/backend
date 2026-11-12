import { createApp } from "../interfaces/http/app.js";
import { createManagers } from "../infrastructure/persistence/mongo.js";
import { log } from "../interfaces/http/logger.js";
import { schedulerRun } from "../application/ops.js";
import { scheduleDueRecurringStories } from "../application/recurring-story-publisher.js";
import { refreshInstagramLoginToken } from "../application/instagram-token-refresher.js";

const port = Number(process.env.PORT ?? 8787);
const {
  persistence,
  manager,
  press,
  platform,
  users,
  directory,
  monetization,
  mcpOAuth,
  instagramConnections,
  editorialVoice,
  mail,
  media,
  socialTemplates,
  socialSeries,
  instagramTrustedCollaborators,
} = await createManagers();
const app = await createApp(
  manager,
  press,
  undefined,
  users,
  directory,
  monetization,
  mcpOAuth,
  instagramConnections,
  editorialVoice,
  mail,
  undefined,
  media,
  platform,
  socialTemplates,
  instagramTrustedCollaborators,
  socialSeries,
);

app.listen(port, () => log("info", "server_started", { port }));

const interval = Number(process.env.SCHEDULER_INTERVAL_MS ?? 30_000);
const timer = setInterval(
  () =>
    void schedulerRun(async () => {
      if (socialSeries && socialTemplates) {
        const scheduledStories = await scheduleDueRecurringStories(manager, socialSeries, socialTemplates);
        if (scheduledStories) {
          log("info", "recurring_instagram_stories_scheduled", {
            count: scheduledStories,
            timeZone: "America/Argentina/Buenos_Aires",
          });
        }
      }
      await manager.publishDue();
      if (process.env.PRESS_AUTO_FOLLOWUP === "true") await press.sendDueFollowups(false);
    }).catch((error) => log("error", "scheduler_failed", { error: (error as Error).message })),
  interval,
);
timer.unref();

const mediaMaintenanceInterval = Number(process.env.MEDIA_MAINTENANCE_INTERVAL_MS ?? 7 * 24 * 60 * 60 * 1000);
const mediaTimer = setInterval(
  () =>
    void schedulerRun(async () => {
      if (!media) return;
      await media.cleanup();
      await media.reconcile();
    }).catch((error) => log("error", "media_maintenance_failed", { error: (error as Error).message })),
  mediaMaintenanceInterval,
);
mediaTimer.unref();

const tokenRefreshInterval = 12 * 60 * 60 * 1000;
const refreshInstagramToken = () =>
  void schedulerRun(async () => {
    if (!instagramConnections) return;
    const refreshed = await refreshInstagramLoginToken(instagramConnections);
    if (refreshed) log("info", "instagram_access_token_refreshed", { provider: "instagram_login" });
  }).catch((error) => log("error", "instagram_access_token_refresh_failed", { error: (error as Error).message }));
const tokenTimer = setInterval(refreshInstagramToken, tokenRefreshInterval);
tokenTimer.unref();
refreshInstagramToken();

const collabTimer = setInterval(
  () =>
    void schedulerRun(async () => {
      if (!instagramTrustedCollaborators) return;
      const facebookConnection = await instagramConnections?.getDefault();
      if (
        facebookConnection?.apiHost !== "facebook" &&
        (!process.env.META_ACCESS_TOKEN || !process.env.META_INSTAGRAM_ACCOUNT_ID)
      )
        return;
      const { InstagramCommunity } = await import("../infrastructure/integrations/instagram-community.js");
      const result = await new InstagramCommunity(
        instagramTrustedCollaborators,
        instagramConnections,
      ).acceptTrustedCollaborationInvites();
      if (result.accepted.length) log("info", "instagram_collaboration_invites_accepted", result);
    }).catch((error) =>
      log("error", "instagram_collaboration_auto_accept_failed", { error: (error as Error).message }),
    ),
  5 * 60_000,
);
collabTimer.unref();

const shutdown = async () => {
  clearInterval(timer);
  clearInterval(mediaTimer);
  clearInterval(tokenTimer);
  clearInterval(collabTimer);
  await persistence?.client.close();
  process.exit(0);
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
