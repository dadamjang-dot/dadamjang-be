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
        DELETE FROM "identityVerificationSessions"
        WHERE ctid IN (
          SELECT ctid
          FROM "identityVerificationSessions"
          WHERE "expiresAt" <= ${now} OR "consumedAt" IS NOT NULL
          ORDER BY "expiresAt"
          LIMIT 100
        )
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
