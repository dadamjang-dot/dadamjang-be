import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, inArray, lt, lte, notExists, or, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { CustomBadRequestException } from "src/common/errors/custom-exceptions";
import { requireResult } from "src/common/invariants/require-result";
import { type Database, type DatabaseTransaction, DRIZZLE } from "src/modules/database/database.module";
import { mediaObjectPromotions, mediaObjectReferences } from "src/modules/database/schema";
import { MediaErrorMessage } from "./media.error";

export type MediaEntityType = "PRODUCT" | "STYLE_POST";
type ReclaimableStatus = "PREPARING" | "READY";
type Promotion = typeof mediaObjectPromotions.$inferSelect;
type ClaimedGarbage = Promotion & { gcClaimToken: string; gcPreviousStatus: ReclaimableStatus };

export type PromotionInput = Readonly<{
  contentType: string;
  finalKey: string;
  kind: MediaEntityType;
  objectSize: number;
  ownerUserId: string;
  sourceBucket: string;
  sourceEtag: string;
  sourceKey: string;
}>;

export type AdoptedObjectInput = Readonly<{
  contentType: string;
  finalEtag: string;
  finalKey: string;
  kind: MediaEntityType;
  objectSize: number;
  ownerUserId: string;
}>;

const invalidObject = () => new CustomBadRequestException(MediaErrorMessage.ObjectInvalid);

@Injectable()
export class MediaRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  reservePromotion = (input: PromotionInput, now = new Date()) =>
    this.db.transaction(async (tx) => {
      await tx
        .insert(mediaObjectPromotions)
        .values({
          contentType: input.contentType,
          finalKey: input.finalKey,
          kind: input.kind,
          objectSize: input.objectSize,
          ownerUserId: input.ownerUserId,
          sourceBucket: input.sourceBucket,
          sourceEtag: input.sourceEtag,
          sourceKey: input.sourceKey,
          status: "PREPARING",
          unreferencedAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing();
      const promotion = await this.lockPromotion(tx, input.finalKey);
      this.assertManagedPromotion(promotion, input);
      if (promotion.status === "DELETING") throw invalidObject();
      if (promotion.status !== "DELETED") return promotion;
      return requireResult(
        (
          await tx
            .update(mediaObjectPromotions)
            .set({
              deletedAt: null,
              finalEtag: null,
              readyAt: null,
              status: "PREPARING",
              unreferencedAt: now,
              updatedAt: now,
            })
            .where(eq(mediaObjectPromotions.finalKey, input.finalKey))
            .returning()
        )[0],
      );
    });

  markPromotionReady = async (finalKey: string, finalEtag: string, now = new Date()) => {
    const [promotion] = await this.db
      .update(mediaObjectPromotions)
      .set({ finalEtag, readyAt: now, status: "READY", updatedAt: now })
      .where(
        and(
          eq(mediaObjectPromotions.finalKey, finalKey),
          inArray(mediaObjectPromotions.status, ["PREPARING", "READY"]),
        ),
      )
      .returning({ finalKey: mediaObjectPromotions.finalKey });
    if (!promotion) throw invalidObject();
  };

  adoptFinalObject = (input: AdoptedObjectInput, now = new Date()) =>
    this.db.transaction(async (tx) => {
      await tx
        .insert(mediaObjectPromotions)
        .values({
          contentType: input.contentType,
          finalEtag: input.finalEtag,
          finalKey: input.finalKey,
          kind: input.kind,
          objectSize: input.objectSize,
          ownerUserId: input.ownerUserId,
          readyAt: now,
          status: "READY",
          unreferencedAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing();
      const promotion = await this.lockPromotion(tx, input.finalKey);
      if (
        promotion.kind !== input.kind ||
        promotion.ownerUserId !== input.ownerUserId ||
        promotion.contentType !== input.contentType ||
        (promotion.objectSize !== null && promotion.objectSize !== input.objectSize) ||
        promotion.status === "DELETING"
      )
        throw invalidObject();
      if (promotion.sourceKey !== null && promotion.status !== "READY") throw invalidObject();
      if (promotion.status === "READY" && promotion.sourceKey !== null) return promotion;
      return requireResult(
        (
          await tx
            .update(mediaObjectPromotions)
            .set({
              deletedAt: null,
              finalEtag: input.finalEtag,
              objectSize: input.objectSize,
              readyAt: promotion.readyAt ?? now,
              status: "READY",
              unreferencedAt: promotion.status === "DELETED" ? now : promotion.unreferencedAt,
              updatedAt: now,
            })
            .where(eq(mediaObjectPromotions.finalKey, input.finalKey))
            .returning()
        )[0],
      );
    });

  replaceReferences = async (
    tx: DatabaseTransaction,
    entityType: MediaEntityType,
    entityId: string,
    finalKeys: readonly string[],
    now = new Date(),
  ) => {
    const nextKeys = [...new Set(finalKeys)];
    const previous = await tx
      .select({ finalKey: mediaObjectReferences.finalKey })
      .from(mediaObjectReferences)
      .where(and(eq(mediaObjectReferences.entityType, entityType), eq(mediaObjectReferences.entityId, entityId)))
      .for("update");
    const previousKeys = previous.map(({ finalKey }) => finalKey);
    const lockKeys = [...new Set([...previousKeys, ...nextKeys])];
    const promotions = lockKeys.length
      ? await tx
          .select()
          .from(mediaObjectPromotions)
          .where(inArray(mediaObjectPromotions.finalKey, lockKeys))
          .orderBy(asc(mediaObjectPromotions.finalKey))
          .for("update")
      : [];
    const promotionsByKey = new Map(promotions.map((promotion) => [promotion.finalKey, promotion]));
    if (
      nextKeys.some((key) => {
        const promotion = promotionsByKey.get(key);
        return promotion?.status !== "READY" || promotion.kind !== entityType;
      })
    )
      throw invalidObject();

    await tx
      .delete(mediaObjectReferences)
      .where(and(eq(mediaObjectReferences.entityType, entityType), eq(mediaObjectReferences.entityId, entityId)));
    if (nextKeys.length) {
      await tx
        .insert(mediaObjectReferences)
        .values(nextKeys.map((finalKey) => ({ entityId, entityType, finalKey })))
        .onConflictDoNothing();
      await tx
        .update(mediaObjectPromotions)
        .set({ unreferencedAt: null, updatedAt: now })
        .where(inArray(mediaObjectPromotions.finalKey, nextKeys));
    }

    const removedKeys = previousKeys.filter((key) => !nextKeys.includes(key));
    for (const finalKey of removedKeys) {
      const [remaining] = await tx
        .select({ finalKey: mediaObjectReferences.finalKey })
        .from(mediaObjectReferences)
        .where(eq(mediaObjectReferences.finalKey, finalKey))
        .limit(1);
      if (!remaining)
        await tx
          .update(mediaObjectPromotions)
          .set({ unreferencedAt: now, updatedAt: now })
          .where(
            and(
              eq(mediaObjectPromotions.finalKey, finalKey),
              inArray(mediaObjectPromotions.status, ["PREPARING", "READY"]),
            ),
          );
    }
  };

  claimGarbage = async (now = new Date(), graceMs = 24 * 60 * 60_000) =>
    this.db.transaction(async (tx) => {
      const cutoff = new Date(now.getTime() - graceMs);
      const staleClaim = new Date(now.getTime() - 5 * 60_000);
      const [promotion] = await tx
        .select()
        .from(mediaObjectPromotions)
        .where(
          and(
            notExists(
              tx
                .select({ value: sql`1` })
                .from(mediaObjectReferences)
                .where(eq(mediaObjectReferences.finalKey, mediaObjectPromotions.finalKey)),
            ),
            or(
              and(
                inArray(mediaObjectPromotions.status, ["PREPARING", "READY"]),
                lte(mediaObjectPromotions.unreferencedAt, cutoff),
              ),
              and(eq(mediaObjectPromotions.status, "DELETING"), lt(mediaObjectPromotions.gcClaimedAt, staleClaim)),
            ),
          ),
        )
        .orderBy(asc(mediaObjectPromotions.unreferencedAt), asc(mediaObjectPromotions.createdAt))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!promotion) return undefined;
      const previousStatus =
        promotion.status === "DELETING" ? promotion.gcPreviousStatus : (promotion.status as ReclaimableStatus);
      if (previousStatus !== "PREPARING" && previousStatus !== "READY") throw invalidObject();
      const gcClaimToken = randomUUID();
      const claimed = requireResult(
        (
          await tx
            .update(mediaObjectPromotions)
            .set({
              gcClaimedAt: now,
              gcClaimToken,
              gcPreviousStatus: previousStatus,
              status: "DELETING",
              updatedAt: now,
            })
            .where(eq(mediaObjectPromotions.finalKey, promotion.finalKey))
            .returning()
        )[0],
      );
      return { ...claimed, gcClaimToken, gcPreviousStatus: previousStatus } as ClaimedGarbage;
    });

  completeGarbage = async (claim: ClaimedGarbage, now = new Date()) => {
    const [completed] = await this.db
      .update(mediaObjectPromotions)
      .set({
        deletedAt: now,
        finalEtag: null,
        gcClaimedAt: null,
        gcClaimToken: null,
        gcPreviousStatus: null,
        status: "DELETED",
        unreferencedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(mediaObjectPromotions.finalKey, claim.finalKey),
          eq(mediaObjectPromotions.status, "DELETING"),
          eq(mediaObjectPromotions.gcClaimToken, claim.gcClaimToken),
        ),
      )
      .returning({ finalKey: mediaObjectPromotions.finalKey });
    if (!completed) throw invalidObject();
  };

  private lockPromotion = async (tx: DatabaseTransaction, finalKey: string) =>
    requireResult(
      (
        await tx
          .select()
          .from(mediaObjectPromotions)
          .where(eq(mediaObjectPromotions.finalKey, finalKey))
          .limit(1)
          .for("update")
      )[0],
    );

  private assertManagedPromotion = (promotion: Promotion, input: PromotionInput) => {
    if (
      promotion.kind !== input.kind ||
      promotion.ownerUserId !== input.ownerUserId ||
      promotion.contentType !== input.contentType ||
      promotion.objectSize !== input.objectSize ||
      promotion.sourceBucket !== input.sourceBucket ||
      promotion.sourceKey !== input.sourceKey ||
      promotion.sourceEtag !== input.sourceEtag
    )
      throw invalidObject();
  };
}
