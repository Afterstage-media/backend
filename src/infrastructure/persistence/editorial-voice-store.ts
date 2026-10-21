import type { EditorialVoice, EditorialVoiceInput } from "../../domain/editorial-voice/types.js";

export interface EditorialVoiceRepository {
  get(authorId: string): Promise<EditorialVoice | undefined>;
  upsert(authorId: string, input: EditorialVoiceInput, updatedBy: string): Promise<EditorialVoice>;
}

export class MemoryEditorialVoiceStore implements EditorialVoiceRepository {
  private readonly values = new Map<string, EditorialVoice>();

  async get(authorId: string): Promise<EditorialVoice | undefined> {
    const value = this.values.get(authorId);
    return value ? { ...value, examples: [...value.examples] } : undefined;
  }

  async upsert(authorId: string, input: EditorialVoiceInput, updatedBy: string): Promise<EditorialVoice> {
    const current = this.values.get(authorId);
    const now = new Date().toISOString();
    const value: EditorialVoice = {
      authorId,
      guide: input.guide,
      examples: [...input.examples],
      revision: (current?.revision ?? 0) + 1,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
      updatedBy,
    };
    this.values.set(authorId, value);
    return { ...value, examples: [...value.examples] };
  }
}
