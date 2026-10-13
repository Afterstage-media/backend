import type { ContentStatus } from "./types.js";

const transitions: Record<ContentStatus, ContentStatus[]> = {
  idea: ["draft"],
  draft: ["idea", "review"],
  review: ["draft", "approved"],
  approved: ["draft", "scheduled", "publishing"],
  scheduled: ["approved", "publishing"],
  publishing: ["published", "failed"],
  published: [],
  failed: ["draft", "approved", "publishing"],
};

export const canTransition = (from: ContentStatus, to: ContentStatus): boolean =>
  from === to || transitions[from].includes(to);

export const assertTransition = (from: ContentStatus, to: ContentStatus): void => {
  if (!canTransition(from, to)) throw new Error(`Transición de estado inválida: ${from} → ${to}`);
};
