import { createApp } from "../interfaces/http/app.js";
import { createManagers } from "../infrastructure/persistence/mongo.js";
import { log } from "../interfaces/http/logger.js";
import { schedulerRun } from "../application/ops.js";

const port = Number(process.env.PORT ?? 8787);
const {
  persistence,
  manager,
  press,
  users,
  directory,
  monetization,
  mcpOAuth,
  instagramConnections,
  editorialVoice,
  mail,
  media,
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
);

app.listen(port, () => log("info", "server_started", { port }));

const interval = Number(process.env.SCHEDULER_INTERVAL_MS ?? 30_000);
const timer = setInterval(
  () =>
    void schedulerRun(async () => {
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

const shutdown = async () => {
  clearInterval(timer);
  clearInterval(mediaTimer);
  await persistence?.client.close();
  process.exit(0);
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
