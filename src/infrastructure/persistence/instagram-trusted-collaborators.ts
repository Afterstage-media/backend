import type { Collection, Db } from "mongodb";

export type InstagramTrustedCollaborator = {
  username: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
};
type RecordType = InstagramTrustedCollaborator & { _id: string };

export type InstagramTrustedCollaboratorStore = {
  init(): Promise<void>;
  list(): Promise<InstagramTrustedCollaborator[]>;
  add(username: string, actorId: string): Promise<InstagramTrustedCollaborator>;
  remove(username: string): Promise<boolean>;
  seedDefaultsOnce(usernames: string[]): Promise<void>;
};

export const normalizeInstagramUsername = (value: string): string => {
  const username = value.trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9._]{1,30}$/.test(username)) throw new Error("El usuario de Instagram no es válido");
  return username;
};

export class MongoInstagramTrustedCollaboratorStore implements InstagramTrustedCollaboratorStore {
  constructor(
    private readonly collection: Collection<RecordType>,
    private readonly db: Db,
  ) {}

  async init(): Promise<void> {
    await this.collection.createIndex({ username: 1 }, { unique: true });
  }

  async list(): Promise<InstagramTrustedCollaborator[]> {
    return (await this.collection.find({}).sort({ username: 1 }).toArray()).map(({ _id: _ignored, ...item }) => item);
  }

  async seedDefaultsOnce(usernames: string[]): Promise<void> {
    const migrations = this.db.collection<{ _id: string }>("application_migrations");
    const migrationId = "instagram-trusted-collaborators-defaults-v1";
    if (await migrations.findOne({ _id: migrationId })) return;
    for (const username of usernames) await this.add(username, "bootstrap");
    await migrations.updateOne({ _id: migrationId }, { $setOnInsert: { _id: migrationId } }, { upsert: true });
  }

  async add(value: string, actorId: string): Promise<InstagramTrustedCollaborator> {
    const username = normalizeInstagramUsername(value);
    const now = new Date().toISOString();
    await this.collection.updateOne(
      { _id: username },
      { $setOnInsert: { _id: username, username, createdAt: now, createdBy: actorId }, $set: { updatedAt: now } },
      { upsert: true },
    );
    const record = await this.collection.findOne({ _id: username });
    if (!record) throw new Error("No se pudo guardar la cuenta confiable de Instagram");
    const { _id: _ignored, ...item } = record;
    return item;
  }

  async remove(value: string): Promise<boolean> {
    return (await this.collection.deleteOne({ _id: normalizeInstagramUsername(value) })).deletedCount === 1;
  }
}

export const createInstagramTrustedCollaboratorStore = (db: Db): MongoInstagramTrustedCollaboratorStore =>
  new MongoInstagramTrustedCollaboratorStore(db.collection<RecordType>("instagram_trusted_collaborators"), db);
