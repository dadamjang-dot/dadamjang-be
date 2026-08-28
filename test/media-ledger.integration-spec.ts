import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { INestApplication } from "@nestjs/common";
import type { Pool } from "pg";
import sharp from "sharp";
import { createApp } from "src/app";
import { type Database, DRIZZLE } from "src/modules/database/database.module";
import { MediaRepository } from "src/modules/media/media.repository";
import { MediaService } from "src/modules/media/media.service";
import { resetTestFixtures, testPool } from "./support/database";

const ownerUserId = "00000000-0000-4000-8000-000000000001";
const pendingKey = `pending/products/${ownerUserId}/90000000-0000-4000-8000-000000000003.png`;
const pendingBucket = "integration-private-pending-bucket";

const missingObject = () => Object.assign(new Error("missing"), { $metadata: { httpStatusCode: 404 } });

describe("media object ledger integration", () => {
  let app: INestApplication;
  let database: Database;
  let mediaRepository: MediaRepository;
  let mediaService: MediaService;
  let png: Buffer;
  let pool: Pool;
  let storageCommands: unknown[];
  let storedFinals: Map<string, { etag: string; metadata: Record<string, string> }>;

  beforeAll(async () => {
    png = await sharp({
      create: { width: 4, height: 3, channels: 4, background: "#ff00ffff" },
    })
      .png()
      .toBuffer();
    pool = testPool();
    app = await createApp();
    await app.init();
    database = app.get(DRIZZLE);
    mediaRepository = app.get(MediaRepository);
    mediaService = app.get(MediaService);
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await resetTestFixtures(pool);
    storageCommands = [];
    storedFinals = new Map();
    jest.spyOn(S3Client.prototype, "send").mockImplementation(async (command) => {
      storageCommands.push(command);
      if (command instanceof HeadObjectCommand) {
        if (command.input.Bucket === pendingBucket && command.input.Key === pendingKey)
          return {
            ContentType: "image/png",
            ContentLength: png.byteLength,
            Metadata: {
              "owner-id": ownerUserId,
              "declared-content-type": "image/png",
              "declared-size": String(png.byteLength),
            },
            ETag: '"pending-etag"',
          };
        const stored = command.input.Key ? storedFinals.get(command.input.Key) : undefined;
        if (!stored) throw missingObject();
        return {
          ContentType: "image/png",
          ContentLength: png.byteLength,
          Metadata: stored.metadata,
          ETag: stored.etag,
        };
      }
      if (command instanceof GetObjectCommand) {
        const final = command.input.Key ? storedFinals.get(command.input.Key) : undefined;
        return {
          ContentType: "image/png",
          ContentLength: png.byteLength,
          ETag: final?.etag ?? '"pending-etag"',
          Body: { transformToByteArray: async () => png },
        };
      }
      if (command instanceof CopyObjectCommand) {
        if (!command.input.Key) throw new Error("missing copy destination");
        storedFinals.set(command.input.Key, {
          etag: '"final-etag"',
          metadata: command.input.Metadata ?? {},
        });
        return { CopyObjectResult: { ETag: '"final-etag"' } };
      }
      if (command instanceof DeleteObjectCommand) {
        if (command.input.Key) storedFinals.delete(command.input.Key);
        return {};
      }
      throw new Error("unexpected storage command");
    });
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  const promote = () => mediaService.validateProductImageObject(pendingKey, ownerUserId);

  const installCommitFailure = async (entityId: string) => {
    await pool.query(`
      CREATE FUNCTION reject_media_reference_commit() RETURNS trigger AS $$
      BEGIN
        IF NEW."entityId" = '${entityId}'::uuid THEN
          RAISE EXCEPTION 'blocked media reference commit';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await pool.query(`
      CREATE CONSTRAINT TRIGGER reject_media_reference_commit
      AFTER INSERT ON "mediaObjectReferences"
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION reject_media_reference_commit()
    `);
  };

  const removeCommitFailure = async () => {
    await pool.query(`DROP TRIGGER reject_media_reference_commit ON "mediaObjectReferences"`);
    await pool.query(`DROP FUNCTION reject_media_reference_commit()`);
  };

  it("garbage-collects a final object left unreferenced by a DB commit failure", async () => {
    const entityId = "70000000-0000-4000-8000-000000000091";
    const finalKey = await promote();
    await installCommitFailure(entityId);
    try {
      await expect(
        database.transaction((tx) =>
          mediaRepository.replaceReferences(tx, "PRODUCT", entityId, [finalKey], new Date()),
        ),
      ).rejects.toThrow();
    } finally {
      await removeCommitFailure();
    }
    await pool.query(
      `UPDATE "mediaObjectPromotions" SET "unreferencedAt" = now() - interval '2 days' WHERE "finalKey" = $1`,
      [finalKey],
    );

    await expect(mediaService.runGarbageCollectionOnce(new Date())).resolves.toBe(true);

    expect(storageCommands.some((command) => command instanceof DeleteObjectCommand)).toBe(true);
    const state = await pool.query<{ referenceCount: number; status: string }>(
      `SELECT p."status",
         (SELECT count(*)::int FROM "mediaObjectReferences" r WHERE r."finalKey" = p."finalKey") AS "referenceCount"
       FROM "mediaObjectPromotions" p WHERE p."finalKey" = $1`,
      [finalKey],
    );
    expect(state.rows[0]).toEqual({ referenceCount: 0, status: "DELETED" });
    expect(storedFinals.has(finalKey)).toBe(false);
  });

  it("reuses the deterministic final object and records a reference on retry", async () => {
    const entityId = "70000000-0000-4000-8000-000000000092";
    const finalKey = await promote();
    await installCommitFailure(entityId);
    try {
      await expect(
        database.transaction((tx) =>
          mediaRepository.replaceReferences(tx, "PRODUCT", entityId, [finalKey], new Date()),
        ),
      ).rejects.toThrow();
    } finally {
      await removeCommitFailure();
    }

    const retriedKey = await promote();
    await database.transaction((tx) =>
      mediaRepository.replaceReferences(tx, "PRODUCT", entityId, [retriedKey], new Date()),
    );
    await pool.query(
      `UPDATE "mediaObjectPromotions" SET "unreferencedAt" = now() - interval '2 days' WHERE "finalKey" = $1`,
      [finalKey],
    );

    expect(retriedKey).toBe(finalKey);
    expect(storageCommands.filter((command) => command instanceof CopyObjectCommand)).toHaveLength(1);
    await expect(mediaService.runGarbageCollectionOnce(new Date())).resolves.toBe(false);
    expect(storageCommands.some((command) => command instanceof DeleteObjectCommand)).toBe(false);
    const state = await pool.query<{ referenceCount: number; status: string }>(
      `SELECT p."status",
         (SELECT count(*)::int FROM "mediaObjectReferences" r WHERE r."finalKey" = p."finalKey") AS "referenceCount"
       FROM "mediaObjectPromotions" p WHERE p."finalKey" = $1`,
      [finalKey],
    );
    expect(state.rows[0]).toEqual({ referenceCount: 1, status: "READY" });
  });

  it("recovers an ambiguous promotion-state write without copying the final object twice", async () => {
    const markReady = jest.spyOn(mediaRepository, "markPromotionReady").mockRejectedValueOnce(new Error("db down"));

    await expect(promote()).rejects.toThrow("db down");
    const finalKey = await promote();

    expect(markReady).toHaveBeenCalledTimes(2);
    expect(storageCommands.filter((command) => command instanceof CopyObjectCommand)).toHaveLength(1);
    const state = await pool.query<{ finalEtag: string; status: string }>(
      `SELECT "finalEtag", "status" FROM "mediaObjectPromotions" WHERE "finalKey" = $1`,
      [finalKey],
    );
    expect(state.rows[0]).toEqual({ finalEtag: '"final-etag"', status: "READY" });
  });

  it("rejects attaching a promoted object to a different entity type", async () => {
    const finalKey = await promote();

    await expect(
      database.transaction((tx) =>
        mediaRepository.replaceReferences(tx, "STYLE_POST", "70000000-0000-4000-8000-000000000094", [finalKey]),
      ),
    ).rejects.toThrow();
    const referenceCount = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS "count" FROM "mediaObjectReferences" WHERE "finalKey" = $1`,
      [finalKey],
    );
    expect(referenceCount.rows[0]?.count).toBe(0);
  });

  it("never deletes a deterministic object while a concurrent transaction is referencing it", async () => {
    const entityId = "70000000-0000-4000-8000-000000000093";
    const finalKey = await promote();
    await pool.query(
      `UPDATE "mediaObjectPromotions" SET "unreferencedAt" = now() - interval '2 days' WHERE "finalKey" = $1`,
      [finalKey],
    );
    let releaseReference!: () => void;
    let referenceLocked!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseReference = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      referenceLocked = resolve;
    });
    const reference = database.transaction(async (tx) => {
      await mediaRepository.replaceReferences(tx, "PRODUCT", entityId, [finalKey], new Date());
      referenceLocked();
      await release;
    });
    await locked;

    const garbageCollection = await mediaService.runGarbageCollectionOnce(new Date());
    releaseReference();
    await reference;

    expect(garbageCollection).toBe(false);
    expect(storageCommands.some((command) => command instanceof DeleteObjectCommand)).toBe(false);
    const state = await pool.query<{ referenceCount: number; status: string; unreferencedAt: Date | null }>(
      `SELECT p."status", p."unreferencedAt",
         (SELECT count(*)::int FROM "mediaObjectReferences" r WHERE r."finalKey" = p."finalKey") AS "referenceCount"
       FROM "mediaObjectPromotions" p WHERE p."finalKey" = $1`,
      [finalKey],
    );
    expect(state.rows[0]).toEqual({ referenceCount: 1, status: "READY", unreferencedAt: null });
  });
});
