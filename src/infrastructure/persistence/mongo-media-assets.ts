import { type Collection, type Db } from "mongodb";

export type MediaAssetStatus =
  "reserving" | "pending" | "uploaded" | "linked" | "delete_pending" | "orphaned" | "missing" | "deleted";

export type MediaObjectMetadata = {
  key: string;
  size: number;
  contentType: string;
  etag?: string;
  uploaded?: string;
};

export type MediaAssetRecord = {
  _id: string;
  reservationId: string;
  requestedContentId: string | null;
  contentId: string | null;
  key: string;
  contentType: string;
  sizeBytes: number;
  monthKey: string;
  status: MediaAssetStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  deleteAfter: string | null;
  uploadedAt: string | null;
  linkedAt: string | null;
  deletedAt: string | null;
  lastError: string | null;
};

export type MediaReservation = MediaAssetRecord & {
  totalBytesAfterReservation: number;
  monthlyBytesAfterReservation: number;
};

type MediaQuotaRecord = {
  _id: "global";
  monthKey: string;
  totalReservedBytes: number;
  monthlyReservedBytes: number;
  updatedAt: string;
};

export class MediaQuotaExceededError extends Error {
  constructor(scope: "total" | "monthly") {
    super(scope === "total" ? "storage_quota_exceeded" : "monthly_upload_quota_exceeded");
    this.name = "MediaQuotaExceededError";
  }
}

export class MediaAssetNotFoundError extends Error {
  constructor(id: string) {
    super(`No existe el asset de medios ${id}`);
    this.name = "MediaAssetNotFoundError";
  }
}

const monthKey = (date = new Date()): string => {
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${date.getUTCFullYear()}-${month}`;
};
const envNumber = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
};
const maxTotalBytes = () => envNumber("MEDIA_MAX_TOTAL_BYTES", 25 * 1024 * 1024 * 1024);
const maxMonthlyBytes = () => envNumber("MEDIA_MAX_MONTHLY_UPLOAD_BYTES", 2 * 1024 * 1024 * 1024);
const orphanGraceMs = () => envNumber("MEDIA_ORPHAN_GRACE_MS", 48 * 60 * 60 * 1000);

export class MongoMediaAssetStore {
  private readonly assets: Collection<MediaAssetRecord>;
  private readonly quota: Collection<MediaQuotaRecord>;

  constructor(db: Db) {
    this.assets = db.collection<MediaAssetRecord>("media_assets");
    this.quota = db.collection<MediaQuotaRecord>("media_quota");
  }

  async init(): Promise<void> {
    await Promise.all([
      this.assets.createIndex({ key: 1 }, { unique: true }),
      this.assets.createIndex({ reservationId: 1 }, { unique: true }),
      this.assets.createIndex({ status: 1, deleteAfter: 1 }),
      this.assets.createIndex({ contentId: 1, status: 1 }),
      this.assets.createIndex({ requestedContentId: 1, status: 1 }),
    ]);
  }

  async reserveUpload(input: {
    id: string;
    requestedContentId: string;
    key: string;
    contentType: string;
    sizeBytes: number;
    now?: Date;
  }): Promise<MediaReservation> {
    const now = input.now ?? new Date();
    const timestamp = now.toISOString();
    const currentMonth = monthKey(now);
    const reservationId = input.id;
    const expiresAt = new Date(
      now.getTime() + envNumber("MEDIA_RESERVATION_TTL_MS", 24 * 60 * 60 * 1000),
    ).toISOString();
    const deleteAfter = new Date(now.getTime() + orphanGraceMs()).toISOString();
    const record: MediaAssetRecord = {
      _id: input.id,
      reservationId,
      requestedContentId: input.requestedContentId,
      contentId: null,
      key: input.key,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      monthKey: currentMonth,
      status: "reserving",
      createdAt: timestamp,
      updatedAt: timestamp,
      expiresAt,
      deleteAfter,
      uploadedAt: null,
      linkedAt: null,
      deletedAt: null,
      lastError: null,
    };
    await this.assets.insertOne(record);
    let quota: MediaQuotaRecord | undefined;
    try {
      quota = await this.incrementQuota(currentMonth, input.sizeBytes, now);
      const updated = await this.assets.findOneAndUpdate(
        { _id: input.id, status: "reserving" },
        {
          $set: {
            status: "pending",
            updatedAt: timestamp,
          },
        },
        { returnDocument: "after" },
      );
      if (!updated) throw new Error("No se pudo confirmar la reserva del asset");
      return {
        ...updated,
        totalBytesAfterReservation: quota.totalReservedBytes,
        monthlyBytesAfterReservation: quota.monthlyReservedBytes,
      };
    } catch (error) {
      if (quota) await this.releaseQuota(record, now).catch(() => undefined);
      await this.assets.deleteOne({ _id: input.id }).catch(() => undefined);
      throw error;
    }
  }

  private async incrementQuota(currentMonth: string, sizeBytes: number, now: Date): Promise<MediaQuotaRecord> {
    const updatedAt = now.toISOString();
    await this.quota.updateOne(
      { _id: "global" },
      { $setOnInsert: { monthKey: currentMonth, totalReservedBytes: 0, monthlyReservedBytes: 0, updatedAt } },
      { upsert: true },
    );
    const result = await this.quota.findOneAndUpdate(
      {
        _id: "global",
        $expr: {
          $and: [
            { $lte: [{ $add: [{ $ifNull: ["$totalReservedBytes", 0] }, sizeBytes] }, maxTotalBytes()] },
            {
              $lte: [
                {
                  $add: [
                    {
                      $cond: [{ $eq: ["$monthKey", currentMonth] }, { $ifNull: ["$monthlyReservedBytes", 0] }, 0],
                    },
                    sizeBytes,
                  ],
                },
                maxMonthlyBytes(),
              ],
            },
          ],
        },
      } as never,
      [
        {
          $set: {
            totalReservedBytes: { $add: [{ $ifNull: ["$totalReservedBytes", 0] }, sizeBytes] },
            monthlyReservedBytes: {
              $add: [
                { $cond: [{ $eq: ["$monthKey", currentMonth] }, { $ifNull: ["$monthlyReservedBytes", 0] }, 0] },
                sizeBytes,
              ],
            },
            monthKey: currentMonth,
            updatedAt,
          },
        },
      ] as never,
      { returnDocument: "after" },
    );
    if (!result) {
      const current = await this.quota.findOne({ _id: "global" });
      if ((current?.totalReservedBytes ?? 0) + sizeBytes > maxTotalBytes()) throw new MediaQuotaExceededError("total");
      throw new MediaQuotaExceededError("monthly");
    }
    return result;
  }

  async get(id: string): Promise<MediaAssetRecord | undefined> {
    return (await this.assets.findOne({ _id: id })) ?? undefined;
  }

  async getByKey(key: string): Promise<MediaAssetRecord | undefined> {
    return (await this.assets.findOne({ key })) ?? undefined;
  }

  async markUploaded(id: string, now = new Date()): Promise<MediaAssetRecord> {
    const result = await this.assets.findOneAndUpdate(
      { _id: id, status: { $in: ["pending", "uploaded"] } },
      { $set: { status: "uploaded", uploadedAt: now.toISOString(), updatedAt: now.toISOString(), lastError: null } },
      { returnDocument: "after" },
    );
    if (!result) throw new MediaAssetNotFoundError(id);
    return result;
  }

  async syncContentAssets(contentId: string, assetIds: string[], now = new Date()): Promise<void> {
    const timestamp = now.toISOString();
    const grace = new Date(now.getTime() + orphanGraceMs()).toISOString();
    await this.assets.updateMany(
      { contentId, status: "linked", _id: { $nin: assetIds } },
      { $set: { contentId: null, status: "delete_pending", deleteAfter: grace, updatedAt: timestamp } },
    );
    if (assetIds.length) {
      await this.assets.updateMany(
        {
          _id: { $in: assetIds },
          requestedContentId: contentId,
          status: { $in: ["uploaded", "pending", "delete_pending"] },
        },
        {
          $set: {
            contentId,
            status: "linked",
            linkedAt: timestamp,
            deleteAfter: null,
            updatedAt: timestamp,
            lastError: null,
          },
        },
      );
    }
  }

  async cancelReservation(id: string, now = new Date()): Promise<void> {
    const asset = await this.assets.findOne({ _id: id });
    if (!asset || asset.status === "deleted" || asset.status === "orphaned") return;
    const transitioned = await this.assets.findOneAndUpdate(
      { _id: id, status: { $ne: "deleted" } },
      { $set: { status: "deleted", deletedAt: now.toISOString(), updatedAt: now.toISOString(), lastError: null } },
      { returnDocument: "before" },
    );
    if (transitioned) await this.releaseQuota(transitioned, now);
  }

  async markDeleted(id: string, now = new Date()): Promise<void> {
    const asset = await this.assets.findOne({ _id: id });
    if (!asset || asset.status === "deleted") return;
    const transitioned = await this.assets.findOneAndUpdate(
      { _id: id, status: { $ne: "deleted" } },
      { $set: { status: "deleted", deletedAt: now.toISOString(), updatedAt: now.toISOString(), lastError: null } },
      { returnDocument: "before" },
    );
    if (transitioned && transitioned.status !== "orphaned") await this.releaseQuota(transitioned, now);
  }

  private async releaseQuota(asset: MediaAssetRecord, now: Date): Promise<void> {
    const currentMonth = monthKey(now);
    const update =
      asset.monthKey === currentMonth
        ? { $inc: { totalReservedBytes: -asset.sizeBytes, monthlyReservedBytes: -asset.sizeBytes } }
        : { $inc: { totalReservedBytes: -asset.sizeBytes } };
    await this.quota.updateOne({ _id: "global" }, { ...update, $set: { updatedAt: now.toISOString() } } as never);
  }

  async cleanupCandidates(now: Date): Promise<MediaAssetRecord[]> {
    return this.assets
      .find({
        status: { $in: ["reserving", "pending", "uploaded", "delete_pending", "orphaned"] },
        deleteAfter: { $lte: now.toISOString() },
      })
      .limit(200)
      .toArray();
  }

  async recordError(id: string, message: string, now = new Date()): Promise<void> {
    await this.assets.updateOne(
      { _id: id },
      { $set: { lastError: message.slice(0, 1000), updatedAt: now.toISOString() } },
    );
  }

  async recordOrphan(object: MediaObjectMetadata, now = new Date()): Promise<void> {
    const timestamp = now.toISOString();
    const deleteAfter = new Date(now.getTime() + orphanGraceMs()).toISOString();
    const known = await this.assets.findOne({ key: object.key });
    if (known && known.status !== "orphaned" && known.status !== "deleted") return;
    await this.assets.updateOne(
      { key: object.key },
      {
        $set: {
          contentType: object.contentType,
          sizeBytes: object.size,
          status: "orphaned",
          deleteAfter,
          updatedAt: timestamp,
          lastError: "R2 object has no Mongo reference",
        },
        $setOnInsert: {
          _id: `orphan-${object.key}`,
          reservationId: `orphan-${object.key}`,
          requestedContentId: null,
          contentId: null,
          key: object.key,
          monthKey: monthKey(now),
          createdAt: timestamp,
          expiresAt: null,
          uploadedAt: object.uploaded ?? null,
          linkedAt: null,
          deletedAt: null,
        },
      } as never,
      { upsert: true },
    );
  }

  async markMissing(seenKeys: Set<string>, now = new Date()): Promise<number> {
    const active = await this.assets.find({ status: { $in: ["uploaded", "linked", "delete_pending"] } }).toArray();
    let count = 0;
    for (const asset of active) {
      if (seenKeys.has(asset.key)) continue;
      await this.markMissingAsset(asset, now);
      count += 1;
    }
    return count;
  }

  private async markMissingAsset(asset: MediaAssetRecord, now: Date): Promise<void> {
    await this.releaseQuota(asset, now);
    await this.assets.updateOne(
      { _id: asset._id, status: { $ne: "deleted" } },
      {
        $set: {
          status: "missing",
          deletedAt: now.toISOString(),
          updatedAt: now.toISOString(),
          lastError: "R2 object missing during reconciliation",
        },
      },
    );
  }
}
