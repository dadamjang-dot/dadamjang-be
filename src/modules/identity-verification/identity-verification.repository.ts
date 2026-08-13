import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gt, isNull } from "drizzle-orm";
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

  createSession = async (input: {
    purpose: IdentityVerificationPurposeValue;
    provider: IdentityVerificationProviderValue;
    deviceIdHash: string;
    merchantTransactionId: string;
    expiresAt: Date;
  }) => (await this.db.insert(identityVerificationSessions).values(input).returning())[0];

  findSession = (sessionId: string) =>
    this.db.query.identityVerificationSessions.findFirst({
      where: eq(identityVerificationSessions.sessionId, sessionId),
    });

  markVerified = async (input: {
    sessionId: string;
    ciHash: string;
    certificateProvider: string;
    isFourteenOrOlder: boolean;
  }) =>
    (
      await this.db
        .update(identityVerificationSessions)
        .set({
          status: "VERIFIED",
          ciHash: input.ciHash,
          certificateProvider: input.certificateProvider,
          isFourteenOrOlder: input.isFourteenOrOlder,
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

  completeSession = async (sessionId: string, deviceIdHash: string, token: string) =>
    (
      await this.db
        .update(identityVerificationSessions)
        .set({ proofTokenHash: hashToken(token), completedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(identityVerificationSessions.sessionId, sessionId),
            eq(identityVerificationSessions.deviceIdHash, deviceIdHash),
            eq(identityVerificationSessions.status, "VERIFIED"),
            isNull(identityVerificationSessions.completedAt),
            gt(identityVerificationSessions.expiresAt, new Date()),
          ),
        )
        .returning()
    )[0];
}
