import type { Collection, Db } from "mongodb";
import { decryptSecret, encryptSecret } from "../security/secret-box.js";

export type InstagramConnectionCredentials = {
  accountId: string;
  username: string;
  accessToken: string;
  expiresAt: string | null;
  scopes: string[];
};

export type InstagramConnectionView = {
  accountId: string;
  username: string;
  expiresAt: string | null;
  scopes: string[];
  connectedAt: string;
  updatedAt: string;
};

type InstagramConnectionRecord = InstagramConnectionView & {
  _id: string;
  accessTokenEncrypted: string;
  connectedByUserId: string;
};

export type InstagramConnectionInput = {
  accountId: string;
  username: string;
  accessToken: string;
  expiresAt: string | null;
  scopes: string[];
  connectedByUserId: string;
};

export type InstagramConnectionStore = {
  init(): Promise<void>;
  list(): Promise<InstagramConnectionView[]>;
  getDefault(): Promise<InstagramConnectionCredentials | undefined>;
  upsert(input: InstagramConnectionInput): Promise<InstagramConnectionView>;
  remove(accountId: string): Promise<boolean>;
};

const viewOf = (record: InstagramConnectionRecord): InstagramConnectionView => ({
  accountId: record.accountId,
  username: record.username,
  expiresAt: record.expiresAt,
  scopes: record.scopes,
  connectedAt: record.connectedAt,
  updatedAt: record.updatedAt,
});

export class MongoInstagramConnectionStore implements InstagramConnectionStore {
  constructor(private readonly collection: Collection<InstagramConnectionRecord>) {}

  async init(): Promise<void> {
    await this.collection.createIndex({ accountId: 1 }, { unique: true });
    await this.collection.createIndex({ updatedAt: -1 });
  }

  async list(): Promise<InstagramConnectionView[]> {
    const records = await this.collection.find({}).sort({ updatedAt: -1 }).toArray();
    return records.map(viewOf);
  }

  async getDefault(): Promise<InstagramConnectionCredentials | undefined> {
    const preferredId = process.env.META_INSTAGRAM_ACCOUNT_ID;
    const record = preferredId
      ? await this.collection.findOne({ accountId: preferredId })
      : await this.collection.findOne({}, { sort: { updatedAt: -1 } });
    if (!record) return undefined;
    return {
      accountId: record.accountId,
      username: record.username,
      accessToken: decryptSecret(record.accessTokenEncrypted),
      expiresAt: record.expiresAt,
      scopes: record.scopes,
    };
  }

  async upsert(input: InstagramConnectionInput): Promise<InstagramConnectionView> {
    const now = new Date().toISOString();
    const existing = await this.collection.findOne({ accountId: input.accountId });
    const record: InstagramConnectionRecord = {
      _id: existing?._id ?? input.accountId,
      accountId: input.accountId,
      username: input.username,
      accessTokenEncrypted: encryptSecret(input.accessToken),
      expiresAt: input.expiresAt,
      scopes: [...new Set(input.scopes)].sort(),
      connectedAt: existing?.connectedAt ?? now,
      updatedAt: now,
      connectedByUserId: input.connectedByUserId,
    };
    await this.collection.replaceOne({ _id: record._id }, record, { upsert: true });
    return viewOf(record);
  }

  async remove(accountId: string): Promise<boolean> {
    return (await this.collection.deleteOne({ accountId })).deletedCount === 1;
  }
}

export const createInstagramConnectionStore = (db: Db): MongoInstagramConnectionStore =>
  new MongoInstagramConnectionStore(db.collection<InstagramConnectionRecord>("instagram_connections"));
