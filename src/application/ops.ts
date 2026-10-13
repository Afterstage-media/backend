export type SchedulerStatus = {
  running: boolean;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  runs: number;
};
const state: SchedulerStatus = {
  running: false,
  lastRunAt: null,
  lastSuccessAt: null,
  lastError: null,
  runs: 0,
};
export const schedulerStatus = () => ({ ...state });
export const schedulerRun = async (job: () => Promise<void>) => {
  if (state.running) return false;
  state.running = true;
  state.runs += 1;
  state.lastRunAt = new Date().toISOString();
  try {
    await job();
    state.lastSuccessAt = new Date().toISOString();
    state.lastError = null;
    return true;
  } catch (error) {
    state.lastError = (error as Error).message;
    throw error;
  } finally {
    state.running = false;
  }
};
