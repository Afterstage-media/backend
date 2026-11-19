import type { ScrapedItem } from "../../domain/ai-news/types.js";

type MongoNewsRecord = Record<string, unknown> & { _id: string };

export const mongoNewsItemToScrapedItem = ({ _id, ...item }: MongoNewsRecord): ScrapedItem =>
  ({ ...item, id: _id }) as unknown as ScrapedItem;
