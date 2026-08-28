import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { hashToken } from "src/common/security/token-hash";
import { Database, DRIZZLE } from "src/modules/database/database.module";
import { identityVerificationSessions } from "src/modules/database/schema";
import type {
  IdentityVerificationProviderValue,
  IdentityVerificationPurposeValue,
} from "./identity-verification.types";

@Injectable()
export class IdentityVerificationRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  createSession = (input: {
    purpose: IdentityVerificationPurposeValue;
    provider: IdentityVerificationProviderValue;
    deviceIdHash: string;
    merchantTransactionId: string;
    expiresAt: Date;
  }) =>
    this.db.transaction(async (tx) => {
      const now = new Date();
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.deviceIdHash}:${input.purpose}:${input.provider}`}, 4))`,
      );
      const [existing] = await tx
        .select()
        .from(identityVerificationSessions)
        .where(
          and(
            eq(identityVerificationSessions.deviceIdHash, input.deviceIdHash),
            eq(identityVerificationSessions.purpose, input.purpose),
            eq(identityVerificationSessions.provider, input.provider),
            eq(identityVerificationSessions.status, "PENDING"),
            isNull(identityVerificationSessions.consumedAt),
            gt(identityVerificationSessions.expiresAt, now),
          ),
        )
        .orderBy(desc(identityVerificationSessions.createdAt))
        .limit(1);
      if (existing) return existing;
      await tx.execute(sql`
        WITH expired_candidates AS MATERIALIZED (
          SELECT "sessionId"
          FROM "identityVerificationSessions"
          WHERE "expiresAt" <= ${now}
          ORDER BY "expiresAt", "sessionId"
          FOR UPDATE SKIP LOCKED
          LIMIT 100
        ), consumed_candidates AS MATERIALIZED (
          SELECT "sessionId"
          FROM "identityVerificationSessions"
          WHERE "consumedAt" IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
              FROM expired_candidates
              WHERE expired_candidates."sessionId" = "identityVerificationSessions"."sessionId"
            )
          ORDER BY "consumedAt", "sessionId"
          FOR UPDATE SKIP LOCKED
          LIMIT (SELECT 100 - count(*) FROM expired_candidates)
        ), cleanup_candidates AS (
          SELECT "sessionId" FROM expired_candidates
          UNION ALL
          SELECT "sessionId" FROM consumed_candidates
        )
        DELETE FROM "identityVerificationSessions"
        USING cleanup_candidates
        WHERE "identityVerificationSessions"."sessionId" = cleanup_candidates."sessionId"
      `);
      return (await tx.insert(identityVerificationSessions).values(input).returning())[0];
    });

  findSession = (sessionId: string) =>
    this.db.query.identityVerificationSessions.findFirst({
      where: eq(identityVerificationSessions.sessionId, sessionId),
    });

  markVerified = async (input: {
    sessionId: string;
    ciHash: string;
    certificateProvider: string;
    isFourteenOrOlder: boolean;
    callbackTokenHash: string;
  }) =>
    (
      await this.db
        .update(identityVerificationSessions)
        .set({
          status: "VERIFIED",
          ciHash: input.ciHash,
          certificateProvider: input.certificateProvider,
          isFourteenOrOlder: input.isFourteenOrOlder,
          callbackTokenHash: input.callbackTokenHash,
          verifiedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(identityVerificationSessions.sessionId, input.sessionId),
            eq(identityVerificationSessions.status, "PENDING"),
            gt(identityVerificationSessions.expiresAt, new Date()),
          ),
        )
        .returning()
    )[0];

  markFailed = async (sessionId: string, failureCode: string) => {
    await this.db
      .update(identityVerificationSessions)
      .set({ status: "FAILED", failureCode, updatedAt: new Date() })
      .where(
        and(eq(identityVerificationSessions.sessionId, sessionId), eq(identityVerificationSessions.status, "PENDING")),
      );
  };

  completeSession = async (sessionId: string, deviceIdHash: string, callbackToken: string, token: string) =>
    (
      await this.db
        .update(identityVerificationSessions)
        .set({
          callbackTokenHash: null,
          proofTokenHash: hashToken(token),
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(identityVerificationSessions.sessionId, sessionId),
            eq(identityVerificationSessions.deviceIdHash, deviceIdHash),
            eq(identityVerificationSessions.callbackTokenHash, hashToken(callbackToken)),
            eq(identityVerificationSessions.status, "VERIFIED"),
            isNull(identityVerificationSessions.completedAt),
            gt(identityVerificationSessions.expiresAt, new Date()),
          ),
        )
        .returning()
    )[0];
}
