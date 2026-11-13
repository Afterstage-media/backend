import type { Collection } from "mongodb";
import type { MonetizationPromotion, MonetizationStatus } from "../../domain/monetization/types.js";
import type { MonetizationRepository } from "../../application/monetization-manager.js";

type RecordShape = MonetizationPromotion & { _id: string };
export class MongoMonetizationStore implements MonetizationRepository {
  constructor(private readonly collection: Collection<RecordShape>) {}
  async init() {
    await Promise.all([
      this.collection.createIndex({ status: 1, createdAt: -1 }),
      this.collection.createIndex({ customerEmail: 1, createdAt: -1 }),
      this.collection.createIndex({ paymentId: 1 }),
      this.collection.createIndex({ idempotencyKey: 1 }, { unique: true, sparse: true }),
    ]);
  }
  private from(document: RecordShape): MonetizationPromotion {
    const { _id: _ignored, ...item } = document;
    return item;
  }
  async list(status?: MonetizationStatus) {
    return (
      await this.collection
        .find(status ? { status } : {})
        .sort({ createdAt: -1 })
        .toArray()
    ).map((item) => this.from(item));
  }
  async get(id: string) {
    const item = await this.collection.findOne({ _id: id });
    return item ? this.from(item) : undefined;
  }
  async findByIdempotencyKey(key: string) {
    const item = await this.collection.findOne({ idempotencyKey: key });
    return item ? this.from(item) : undefined;
  }
  async withIdempotencyLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const claimId = `idempotency:${key}`;
    try {
      await this.collection.insertOne({
        _id: claimId,
        idempotencyKey: key,
        status: "creating",
        createdAt: new Date().toISOString(),
      } as unknown as RecordShape);
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        const existing = await this.findByIdempotencyKey(key);
        if (existing) return existing as T;
      }
      throw error;
    }
    try {
      return await operation();
    } finally {
      await this.collection.deleteOne({ _id: claimId });
    }
  }
  async create(item: MonetizationPromotion) {
    try {
      await this.collection.insertOne({ _id: item.id, ...item });
    } catch (error) {
      if ((error as { code?: number }).code === 11000 && item.idempotencyKey) {
        const existing = await this.findByIdempotencyKey(item.idempotencyKey);
        if (existing) return existing;
      }
      throw error;
    }
    return item;
  }
  async update(id: string, patch: Partial<MonetizationPromotion>) {
    const result = await this.collection.findOneAndUpdate(
      { _id: id },
      { $set: { ...patch, updatedAt: new Date().toISOString() } },
      { returnDocument: "after" },
    );
    return result ? this.from(result) : undefined;
  }
}
