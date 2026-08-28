import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import { hashToken } from "src/common/security/token-hash";
import type { RefreshTokenStore } from "src/modules/auth/auth.repository";
import type { TokenPayload } from "src/modules/auth/auth.types";
import { Database, DRIZZLE } from "src/modules/database/database.module";
import {
  authIdentities,
  emailVerificationTokens,
  identityVerificationSessions,
  kakaoLoginFlows,
  kakaoSignupTokens,
  userConsentAcceptances,
  users,
  verifiedIdentities,
  type User,
} from "src/modules/database/schema";
import type { KakaoProfile } from "src/modules/auth/auth.types";
import type { ConsentAcceptanceInput } from "./fo-auth.types";
import { InvalidFoAuthProofError } from "./fo-auth.error";

type KakaoSignupInput = {
  readonly kakaoSignupToken: string;
  readonly email?: string;
  readonly emailVerificationToken?: string;
  readonly identityVerificationToken: string;
  readonly deviceIdHash: string;
  readonly userId: string;
  readonly userid: string;
  readonly password: string;
  readonly consents: readonly ConsentAcceptanceInput[];
};

type IssueTokens = (user: User, store: RefreshTokenStore) => Promise<TokenPayload>;

@Injectable()
export class KakaoFlowRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  createFlow = (deviceIdHash: string, expiresAt: Date) =>
    this.db.transaction(async (tx) => {
      const now = new Date();
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${deviceIdHash}, 3))`);
      const [existing] = await tx
        .select()
        .from(kakaoLoginFlows)
        .where(
          and(
            eq(kakaoLoginFlows.deviceIdHash, deviceIdHash),
            eq(kakaoLoginFlows.status, "PENDING"),
            isNull(kakaoLoginFlows.consumedAt),
            gt(kakaoLoginFlows.expiresAt, now),
          ),
        )
        .orderBy(desc(kakaoLoginFlows.createdAt))
        .limit(1);
      if (existing) return existing;
      await tx.execute(sql`
        DELETE FROM "kakaoLoginFlows"
        WHERE ctid IN (
          SELECT ctid
          FROM "kakaoLoginFlows"
          WHERE "expiresAt" <= ${now} OR "consumedAt" IS NOT NULL
          ORDER BY "expiresAt"
          LIMIT 100
        )
      `);
      return (await tx.insert(kakaoLoginFlows).values({ deviceIdHash, expiresAt }).returning())[0];
    });

  acceptCallback = async (
    flowId: string,
    profile: KakaoProfile,
    email: string | undefined,
    callbackTokenHash: string,
  ) => {
    const [existing] = await this.db
      .select({ userId: users.userId })
      .from(authIdentities)
      .innerJoin(users, eq(users.userId, authIdentities.userId))
      .where(and(eq(authIdentities.provider, "kakao"), eq(authIdentities.providerUserId, profile.providerUserId)))
      .limit(1);
    return (
      await this.db
        .update(kakaoLoginFlows)
        .set({
          providerUserId: profile.providerUserId,
          email,
          emailVerified: profile.emailVerified,
          userId: existing?.userId,
          status: existing ? "EXISTING_USER" : "SIGNUP_REQUIRED",
          callbackTokenHash,
          callbackAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(kakaoLoginFlows.flowId, flowId),
            eq(kakaoLoginFlows.status, "PENDING"),
            isNull(kakaoLoginFlows.consumedAt),
            gt(kakaoLoginFlows.expiresAt, new Date()),
          ),
        )
        .returning()
    )[0];
  };

  completeLoginFlow = (
    flowId: string,
    deviceIdHash: string,
    callbackToken: string,
    signupToken: string,
    issueTokens: IssueTokens,
  ) =>
    this.db.transaction(async (tx) => {
      const now = new Date();
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${deviceIdHash}, 0))`);
      const [flow] = await tx
        .update(kakaoLoginFlows)
        .set({ callbackTokenHash: null, consumedAt: now, updatedAt: now })
        .where(
          and(
            eq(kakaoLoginFlows.flowId, flowId),
            eq(kakaoLoginFlows.deviceIdHash, deviceIdHash),
            eq(kakaoLoginFlows.callbackTokenHash, hashToken(callbackToken)),
            inArray(kakaoLoginFlows.status, ["EXISTING_USER", "SIGNUP_REQUIRED"]),
            isNull(kakaoLoginFlows.consumedAt),
            gt(kakaoLoginFlows.expiresAt, now),
          ),
        )
        .returning();
      if (!flow?.providerUserId) throw new InvalidFoAuthProofError();
      await tx
        .update(kakaoLoginFlows)
        .set({ consumedAt: now, updatedAt: now })
        .where(
          and(
            eq(kakaoLoginFlows.deviceIdHash, deviceIdHash),
            ne(kakaoLoginFlows.flowId, flowId),
            isNull(kakaoLoginFlows.consumedAt),
          ),
        );
      if (flow.status === "EXISTING_USER" && flow.userId) {
        const user = await tx.query.users.findFirst({ where: eq(users.userId, flow.userId) });
        if (!user) throw new InvalidFoAuthProofError();
        return { kind: "existing" as const, tokenPayload: await issueTokens(user, tx) };
      }
      if (flow.status !== "SIGNUP_REQUIRED") throw new InvalidFoAuthProofError();
      await tx.insert(kakaoSignupTokens).values({
        tokenHash: hashToken(signupToken),
        providerUserId: flow.providerUserId,
        email: flow.email,
        emailVerified: flow.emailVerified,
        deviceIdHash,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      });
      return {
        kind: "signup" as const,
        email: flow.email ?? undefined,
        emailVerified: flow.emailVerified,
      };
    });

  completeSignup = (input: KakaoSignupInput, issueTokens: IssueTokens) =>
    this.db.transaction(async (tx) => {
      const now = new Date();
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.deviceIdHash}, 0))`);
      const [signup] = await tx
        .update(kakaoSignupTokens)
        .set({ usedAt: now })
        .where(
          and(
            eq(kakaoSignupTokens.tokenHash, hashToken(input.kakaoSignupToken)),
            eq(kakaoSignupTokens.deviceIdHash, input.deviceIdHash),
            isNull(kakaoSignupTokens.usedAt),
            gt(kakaoSignupTokens.expiresAt, now),
          ),
        )
        .returning();
      if (!signup) throw new InvalidFoAuthProofError();
      await tx
        .update(kakaoSignupTokens)
        .set({ usedAt: now })
        .where(
          and(
            eq(kakaoSignupTokens.deviceIdHash, input.deviceIdHash),
            ne(kakaoSignupTokens.tokenHash, signup.tokenHash),
            isNull(kakaoSignupTokens.usedAt),
          ),
        );
      const [identity] = await tx
        .update(identityVerificationSessions)
        .set({ consumedAt: now, updatedAt: now })
        .where(
          and(
            eq(identityVerificationSessions.proofTokenHash, hashToken(input.identityVerificationToken)),
            eq(identityVerificationSessions.purpose, "SIGNUP"),
            eq(identityVerificationSessions.deviceIdHash, input.deviceIdHash),
            eq(identityVerificationSessions.status, "VERIFIED"),
            eq(identityVerificationSessions.isFourteenOrOlder, true),
            isNull(identityVerificationSessions.consumedAt),
            gt(identityVerificationSessions.expiresAt, now),
          ),
        )
        .returning();
      if (!identity?.ciHash || !identity.certificateProvider) throw new InvalidFoAuthProofError();
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${identity.ciHash}, 1))`);
      const email = signup.emailVerified ? signup.email : input.email;
      if (!email) throw new InvalidFoAuthProofError();
      const emailProof = signup.emailVerified
        ? undefined
        : (
            await tx
              .update(emailVerificationTokens)
              .set({ usedAt: now })
              .where(
                and(
                  eq(emailVerificationTokens.tokenHash, hashToken(input.emailVerificationToken ?? "")),
                  eq(emailVerificationTokens.email, email),
                  eq(emailVerificationTokens.purpose, "SIGNUP"),
                  isNull(emailVerificationTokens.usedAt),
                  gt(emailVerificationTokens.expiresAt, now),
                ),
              )
              .returning()
          )[0];
      if (!signup.emailVerified && !emailProof) throw new InvalidFoAuthProofError();
      const [existing] = await tx
        .select({ user: users })
        .from(verifiedIdentities)
        .innerJoin(users, eq(users.userId, verifiedIdentities.userId))
        .where(eq(verifiedIdentities.ciHash, identity.ciHash))
        .limit(1);
      const user =
        existing?.user ??
        (
          await tx
            .insert(users)
            .values({
              userId: input.userId,
              userid: input.userid,
              email,
              password: input.password,
              role: "USER",
            })
            .returning()
        )[0];
      if (!user) throw new InvalidFoAuthProofError();
      if (user.role !== "USER") throw new InvalidFoAuthProofError();
      const linkedIdentity = await tx.query.authIdentities.findFirst({
        where: and(eq(authIdentities.provider, "kakao"), eq(authIdentities.providerUserId, signup.providerUserId)),
      });
      if (linkedIdentity && linkedIdentity.userId !== user.userId) throw new InvalidFoAuthProofError();
      if (!existing) {
        await tx.insert(verifiedIdentities).values({
          userId: user.userId,
          ciHash: identity.ciHash,
          certificateProvider: identity.certificateProvider,
          verifiedAt: identity.verifiedAt ?? new Date(),
        });
      }
      if (!linkedIdentity) {
        const [createdIdentity] = await tx
          .insert(authIdentities)
          .values({ userId: user.userId, provider: "kakao", providerUserId: signup.providerUserId })
          .onConflictDoNothing({ target: [authIdentities.provider, authIdentities.providerUserId] })
          .returning({ userId: authIdentities.userId });
        if (!createdIdentity) throw new InvalidFoAuthProofError();
      }
      for (const consent of input.consents) {
        const agreedAt = consent.agreed ? new Date() : null;
        await tx
          .insert(userConsentAcceptances)
          .values({ userId: user.userId, documentId: consent.documentId, agreed: consent.agreed, agreedAt })
          .onConflictDoUpdate({
            target: [userConsentAcceptances.userId, userConsentAcceptances.documentId],
            set: { agreed: consent.agreed, agreedAt, recordedAt: new Date() },
          });
      }
      return issueTokens(user, tx);
    });
}
