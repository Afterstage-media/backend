import test from "node:test";
import assert from "node:assert/strict";
import { schedulerRun, schedulerStatus } from "./ops.js";

test("registra ejecuciones exitosas y errores del scheduler", async () => {
  const before = schedulerStatus();
  assert.equal(await schedulerRun(async () => undefined), true);
  const success = schedulerStatus();
  assert.equal(success.runs, before.runs + 1);
  assert.ok(success.lastSuccessAt);
  await assert.rejects(
    () =>
      schedulerRun(async () => {
        throw new Error("falló");
      }),
    /falló/,
  );
  assert.equal(schedulerStatus().lastError, "falló");
});

test("evita dos ejecuciones simultáneas", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = schedulerRun(() => pending);
  assert.equal(await schedulerRun(async () => undefined), false);
  release();
  await running;
});
