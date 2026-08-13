import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gt, isNull, lte, or } from "drizzle-orm";
import { hashToken } from "src/common/security/token-hash";
import { Database, DRIZZLE } from "src/modules/database/database.module";
import {
  consentDocuments,
  emailVerificationTokens,
  identityVerificationSessions,
  userConsentAcceptances,
  users,
  verifiedIdentities,
} from "src/modules/database/schema";
import type { ConsentAcceptanceInput } from "./fo-auth.types";
import { ExistingFoIdentityError, InvalidFoAuthProofError } from "./fo-auth.error";

type SignupUserInput = {
  readonly userId: string;
  readonly userid: string;
  readonly email: string;
  readonly password: string;
  readonly emailVerificationToken: string;
  readonly identityVerificationToken: string;
  readonly deviceIdHash: string;
  readonly consents: readonly ConsentAcceptanceInput[];
};

@Injectable()
export class FoAuthRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  findByEmail = (email: string) => this.db.query.users.findFirst({ where: eq(users.email, email) });

  activeConsentDocuments = (now: Date) =>
    this.db
      .select()
      .from(consentDocuments)
      .where(
        and(
          lte(consentDocuments.activeFrom, now),
          or(isNull(consentDocuments.activeUntil), gt(consentDocuments.activeUntil, now)),
        ),
      )
      .orderBy(consentDocuments.type, desc(consentDocuments.activeFrom));

  createEmailUser = (input: SignupUserInput) =>
    this.db.transaction(async (tx) => {
      const identity = await tx.query.identityVerificationSessions.findFirst({
        where: and(
          eq(identityVerificationSessions.proofTokenHash, hashToken(input.identityVerificationToken)),
          eq(identityVerificationSessions.purpose, "SIGNUP"),
          eq(identityVerificationSessions.deviceIdHash, input.deviceIdHash),
          eq(identityVerificationSessions.status, "VERIFIED"),
          eq(identityVerificationSessions.isFourteenOrOlder, true),
          isNull(identityVerificationSessions.consumedAt),
          gt(identityVerificationSessions.expiresAt, new Date()),
        ),
      });
      if (!identity?.ciHash || !identity.certificateProvider) throw new InvalidFoAuthProofError();
      const existingIdentity = await tx.query.verifiedIdentities.findFirst({
        where: eq(verifiedIdentities.ciHash, identity.ciHash),
      });
      if (existingIdentity) throw new ExistingFoIdentityError();
      const emailProof = await tx.query.emailVerificationTokens.findFirst({
        where: and(
          eq(emailVerificationTokens.tokenHash, hashToken(input.emailVerificationToken)),
          eq(emailVerificationTokens.email, input.email),
          eq(emailVerificationTokens.purpose, "SIGNUP"),
          isNull(emailVerificationTokens.usedAt),
          gt(emailVerificationTokens.expiresAt, new Date()),
        ),
      });
      if (!emailProof) throw new InvalidFoAuthProofError();
      const [user] = await tx
        .insert(users)
        .values({
          userId: input.userId,
          userid: input.userid,
          email: input.email,
          password: input.password,
          role: "USER",
        })
        .returning();
      if (!user) throw new InvalidFoAuthProofError();
      await tx.insert(verifiedIdentities).values({
        userId: user.userId,
        ciHash: identity.ciHash,
        certificateProvider: identity.certificateProvider,
        verifiedAt: identity.verifiedAt ?? new Date(),
      });
      await tx.insert(userConsentAcceptances).values(
        input.consents.map((consent) => ({
          userId: user.userId,
          documentId: consent.documentId,
          agreed: consent.agreed,
          agreedAt: consent.agreed ? new Date() : null,
        })),
      );
      await Promise.all([
        tx
          .update(emailVerificationTokens)
          .set({ usedAt: new Date() })
          .where(eq(emailVerificationTokens.tokenHash, emailProof.tokenHash)),
        tx
          .update(identityVerificationSessions)
          .set({ consumedAt: new Date(), updatedAt: new Date() })
          .where(eq(identityVerificationSessions.sessionId, identity.sessionId)),
      ]);
      return user;
    });

  consumeFindEmailProof = (identityVerificationToken: string, deviceIdHash: string) =>
    this.db.transaction(async (tx) => {
      const [identity] = await tx
        .update(identityVerificationSessions)
        .set({ consumedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(identityVerificationSessions.proofTokenHash, hashToken(identityVerificationToken)),
            eq(identityVerificationSessions.purpose, "FIND_EMAIL"),
            eq(identityVerificationSessions.deviceIdHash, deviceIdHash),
            eq(identityVerificationSessions.status, "VERIFIED"),
            isNull(identityVerificationSessions.consumedAt),
            gt(identityVerificationSessions.expiresAt, new Date()),
          ),
        )
        .returning();
      if (!identity?.ciHash) throw new InvalidFoAuthProofError();
      const [result] = await tx
        .select({ email: users.email })
        .from(verifiedIdentities)
        .innerJoin(users, eq(users.userId, verifiedIdentities.userId))
        .where(eq(verifiedIdentities.ciHash, identity.ciHash))
        .limit(1);
      return result;
    });

  updateMarketingConsent = async (userId: string, agreed: boolean) => {
    const now = new Date();
    const [document] = await this.db
      .select()
      .from(consentDocuments)
      .where(
        and(
          eq(consentDocuments.type, "MARKETING"),
          lte(consentDocuments.activeFrom, now),
          or(isNull(consentDocuments.activeUntil), gt(consentDocuments.activeUntil, now)),
        ),
      )
      .orderBy(desc(consentDocuments.activeFrom))
      .limit(1);
    if (!document) throw new InvalidFoAuthProofError();
    const agreedAt = agreed ? now : null;
    await this.db
      .insert(userConsentAcceptances)
      .values({ userId, documentId: document.documentId, agreed, agreedAt })
      .onConflictDoUpdate({
        target: [userConsentAcceptances.userId, userConsentAcceptances.documentId],
        set: { agreed, agreedAt, recordedAt: now },
      });
    return { agreed, agreedAt: agreedAt ?? undefined };
  };
}
