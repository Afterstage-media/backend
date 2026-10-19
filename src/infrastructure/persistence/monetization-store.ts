import type { Collection } from "mongodb";
import type { MonetizationPromotion, MonetizationStatus } from "../../domain/monetization/types.js";
import type { MonetizationRepository } from "../../application/monetization-manager.js";

type RecordShape = MonetizationPromotion & { _id: string };
export class MongoMonetizationStore implements MonetizationRepository {
  constructor(private readonly collection: Collection<RecordShape>) {}
  async init() { await Promise.all([this.collection.createIndex({ status: 1, createdAt: -1 }), this.collection.createIndex({ customerEmail: 1, createdAt: -1 }), this.collection.createIndex({ paymentId: 1 })]); }
  private from(document: RecordShape): MonetizationPromotion { const { _id: _ignored, ...item } = document; return item; }
  async list(status?: MonetizationStatus) { return (await this.collection.find(status ? { status } : {}).sort({ createdAt: -1 }).toArray()).map((item) => this.from(item)); }
  async get(id: string) { const item = await this.collection.findOne({ _id: id }); return item ? this.from(item) : undefined; }
  async create(item: MonetizationPromotion) { await this.collection.insertOne({ _id: item.id, ...item }); return item; }
  async update(id: string, patch: Partial<MonetizationPromotion>) { const result = await this.collection.findOneAndUpdate({ _id: id }, { $set: { ...patch, updatedAt: new Date().toISOString() } }, { returnDocument: "after" }); return result ? this.from(result) : undefined; }
}
