import { z } from "zod";

/**
 * Validates only fields supplied by a partial update. Zod 4 applies defaults
 * when parsing `object.partial()`, which can unintentionally overwrite stored
 * values. Parsing each present field keeps patch semantics explicit.
 */
export function parsePatch<T extends z.ZodObject>(schema: T, input: unknown): Partial<z.output<T>> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return schema.partial().parse(input) as Partial<z.output<T>>;
  }
  const shape = schema.shape;
  const parsed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const field = shape[key];
    if (field) parsed[key] = field.parse(value);
  }
  return parsed as Partial<z.output<T>>;
}
