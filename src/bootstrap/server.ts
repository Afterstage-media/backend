import { createApp } from "../interfaces/http/app.js";
import { createManagers } from "../infrastructure/persistence/mongo.js";
import { log } from "../interfaces/http/logger.js";
import { schedulerRun } from "../application/ops.js";

const port = Number(process.env.PORT ?? 8787);
const { persistence, manager, press, users, directory } = await createManagers();
const app = await createApp(manager, press, undefined, users, directory);

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

const shutdown = async () => {
  clearInterval(timer);
  await persistence?.client.close();
  process.exit(0);
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
