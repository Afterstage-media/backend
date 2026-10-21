import type { Collection } from "mongodb";
import type { EditorialVoice, EditorialVoiceInput } from "../../domain/editorial-voice/types.js";
import type { EditorialVoiceRepository } from "./editorial-voice-store.js";

type EditorialVoiceRecord = EditorialVoice & { _id: string };

export class MongoEditorialVoiceStore implements EditorialVoiceRepository {
  constructor(private readonly collection: Collection<EditorialVoiceRecord>) {}

  async init(): Promise<void> {
    await this.collection.createIndex({ authorId: 1 }, { unique: true });
  }

  async get(authorId: string): Promise<EditorialVoice | undefined> {
    const document = await this.collection.findOne({ _id: authorId });
    if (!document) return undefined;
    const { _id: _ignored, ...voice } = document;
    return { ...voice, examples: [...voice.examples] };
  }

  async upsert(authorId: string, input: EditorialVoiceInput, updatedBy: string): Promise<EditorialVoice> {
    const now = new Date().toISOString();
    const document = await this.collection.findOneAndUpdate(
      { _id: authorId },
      {
        $set: {
          authorId,
          guide: input.guide,
          examples: [...input.examples],
          updatedAt: now,
          updatedBy,
        },
        $setOnInsert: { createdAt: now },
        $inc: { revision: 1 },
      },
      { upsert: true, returnDocument: "after" },
    );
    if (!document) throw new Error("No se pudo guardar la voz editorial del notero");
    const { _id: _ignored, ...voice } = document;
    return { ...voice, examples: [...voice.examples] };
  }
}
