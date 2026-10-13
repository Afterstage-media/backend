import type { ContentInput, ContentItem } from "./types.js";

export type DuplicateMatch = {
  item: ContentItem;
  score: number;
  reasons: string[];
};

const normalize = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const tokens = (value: string) =>
  new Set(
    normalize(value)
      .split(/\s+/)
      .filter((token) => token.length > 2),
  );
const jaccard = (left: Set<string>, right: Set<string>) => {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
};

/** Returns explainable, deterministic matches without external search services. */
export const detectDuplicates = (
  candidate: Pick<ContentInput, "title" | "slug" | "summary" | "body" | "source">,
  existing: ContentItem[],
  excludeId?: string,
  minimumScore = 0.45,
): DuplicateMatch[] => {
  const title = normalize(candidate.title);
  const slug = normalize(candidate.slug ?? "");
  const body = tokens(`${candidate.summary} ${candidate.body}`);
  const source = normalize(candidate.source);
  return existing
    .filter((item) => item.id !== excludeId)
    .map((item) => {
      const itemTitle = normalize(item.title);
      const itemSlug = normalize(item.slug);
      const titleScore = title && itemTitle === title ? 1 : jaccard(tokens(candidate.title), tokens(item.title));
      const bodyScore = jaccard(body, tokens(`${item.summary} ${item.body}`));
      const sourceMatch = source && normalize(item.source) === source;
      const score = Math.max(titleScore, titleScore * 0.35 + bodyScore * 0.65, slug && slug === itemSlug ? 1 : 0);
      const reasons: string[] = [];
      if (titleScore === 1) reasons.push("título idéntico");
      else if (titleScore >= 0.65) reasons.push("título muy similar");
      if (bodyScore >= 0.8) reasons.push("texto muy similar");
      if (sourceMatch) reasons.push("misma fuente");
      return { item, score, reasons };
    })
    .filter((match) => match.score >= minimumScore)
    .sort((left, right) => right.score - left.score);
};
