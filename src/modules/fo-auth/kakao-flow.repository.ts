import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import { hasBuyerCapability } from "src/auth/role";
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
  readonly password: string | null;
  readonly consents: readonly ConsentAcceptanceInput[];
};

type IssueTokens = (user: User, store: RefreshTokenStore) => Promise<TokenPayload>;
type CompleteExistingUser<T> = (user: User, store: RefreshTokenStore) => Promise<T>;

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
        WITH expired_candidates AS MATERIALIZED (
          SELECT "flowId"
          FROM "kakaoLoginFlows"
          WHERE "expiresAt" <= ${now}
          ORDER BY "expiresAt", "flowId"
          FOR UPDATE SKIP LOCKED
          LIMIT 100
        ), consumed_candidates AS MATERIALIZED (
          SELECT "flowId"
          FROM "kakaoLoginFlows"
          WHERE "consumedAt" IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
              FROM expired_candidates
              WHERE expired_candidates."flowId" = "kakaoLoginFlows"."flowId"
            )
          ORDER BY "consumedAt", "flowId"
          FOR UPDATE SKIP LOCKED
          LIMIT (SELECT 100 - count(*) FROM expired_candidates)
        ), cleanup_candidates AS (
          SELECT "flowId" FROM expired_candidates
          UNION ALL
          SELECT "flowId" FROM consumed_candidates
        )
        DELETE FROM "kakaoLoginFlows"
        USING cleanup_candidates
        WHERE "kakaoLoginFlows"."flowId" = cleanup_candidates."flowId"
      `);
      return (await tx.insert(kakaoLoginFlows).values({ deviceIdHash, expiresAt }).returning())[0];
    });

  acceptCallback = async (
    flowId: string,
    profile: KakaoProfile,
    email: string | undefined,
    callbackTokenHash: string,
  ) =>
    this.db.transaction(async (tx) => {
      const [candidate] = await tx
        .select({ userId: authIdentities.userId })
        .from(authIdentities)
        .where(and(eq(authIdentities.provider, "kakao"), eq(authIdentities.providerUserId, profile.providerUserId)))
        .limit(1);
      let userId: string | undefined;
      if (candidate) {
        const [user] = await tx
          .select({ userId: users.userId })
          .from(users)
          .where(eq(users.userId, candidate.userId))
          .for("update")
          .limit(1);
        const [identity] = user
          ? await tx
              .select({ userId: authIdentities.userId })
              .from(authIdentities)
              .where(
                and(
                  eq(authIdentities.provider, "kakao"),
                  eq(authIdentities.providerUserId, profile.providerUserId),
                  eq(authIdentities.userId, user.userId),
                ),
              )
              .limit(1)
          : [];
        userId = identity?.userId;
      }
      return (
        await tx
          .update(kakaoLoginFlows)
          .set({
            providerUserId: profile.providerUserId,
            email,
            emailVerified: profile.emailVerified,
            userId,
            status: userId ? "EXISTING_USER" : "SIGNUP_REQUIRED",
            callbackTokenHash,
            callbackAt: sql`clock_timestamp()`,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(kakaoLoginFlows.flowId, flowId),
              eq(kakaoLoginFlows.status, "PENDING"),
              isNull(kakaoLoginFlows.consumedAt),
              gt(kakaoLoginFlows.expiresAt, sql`clock_timestamp()`),
            ),
          )
          .returning()
      )[0];
    });

  completeLoginFlow = <T>(
    flowId: string,
    deviceIdHash: string,
    callbackToken: string,
    signupToken: string,
    completeExistingUser: CompleteExistingUser<T>,
  ) =>
    this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${deviceIdHash}, 0))`);
      const [candidate] = await tx
        .select()
        .from(kakaoLoginFlows)
        .where(
          and(
            eq(kakaoLoginFlows.flowId, flowId),
            eq(kakaoLoginFlows.deviceIdHash, deviceIdHash),
            eq(kakaoLoginFlows.callbackTokenHash, hashToken(callbackToken)),
            inArray(kakaoLoginFlows.status, ["EXISTING_USER", "SIGNUP_REQUIRED"]),
            isNull(kakaoLoginFlows.consumedAt),
            gt(kakaoLoginFlows.expiresAt, sql`clock_timestamp()`),
          ),
        )
        .limit(1);
      if (!candidate?.providerUserId) throw new InvalidFoAuthProofError();
      const [user] =
        candidate.status === "EXISTING_USER" && candidate.userId
          ? await tx.select().from(users).where(eq(users.userId, candidate.userId)).limit(1).for("update")
          : [];
      if (candidate.status === "EXISTING_USER" && !user) throw new InvalidFoAuthProofError();
      const [flow] = await tx
        .update(kakaoLoginFlows)
        .set({ callbackTokenHash: null, consumedAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(kakaoLoginFlows.flowId, flowId),
            eq(kakaoLoginFlows.deviceIdHash, deviceIdHash),
            eq(kakaoLoginFlows.callbackTokenHash, hashToken(callbackToken)),
            eq(kakaoLoginFlows.status, candidate.status),
            ...(user ? [eq(kakaoLoginFlows.userId, user.userId)] : [isNull(kakaoLoginFlows.userId)]),
            isNull(kakaoLoginFlows.consumedAt),
            gt(kakaoLoginFlows.expiresAt, sql`clock_timestamp()`),
          ),
        )
        .returning();
      if (!flow?.providerUserId) throw new InvalidFoAuthProofError();
      await tx
        .update(kakaoLoginFlows)
        .set({ consumedAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(kakaoLoginFlows.deviceIdHash, deviceIdHash),
            ne(kakaoLoginFlows.flowId, flowId),
            isNull(kakaoLoginFlows.consumedAt),
          ),
        );
      if (flow.status === "EXISTING_USER" && flow.userId) {
        if (!user || flow.userId !== user.userId) throw new InvalidFoAuthProofError();
        return { kind: "existing" as const, result: await completeExistingUser(user, tx) };
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
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.deviceIdHash}, 0))`);
      const signupTokenHash = hashToken(input.kakaoSignupToken);
      const identityTokenHash = hashToken(input.identityVerificationToken);
      const [signupCandidate] = await tx
        .select()
        .from(kakaoSignupTokens)
        .where(
          and(
            eq(kakaoSignupTokens.tokenHash, signupTokenHash),
            eq(kakaoSignupTokens.deviceIdHash, input.deviceIdHash),
            isNull(kakaoSignupTokens.usedAt),
            gt(kakaoSignupTokens.expiresAt, sql`clock_timestamp()`),
          ),
        )
        .limit(1);
      if (!signupCandidate) throw new InvalidFoAuthProofError();
      const [identityCandidate] = await tx
        .select()
        .from(identityVerificationSessions)
        .where(
          and(
            eq(identityVerificationSessions.proofTokenHash, identityTokenHash),
            eq(identityVerificationSessions.purpose, "SIGNUP"),
            eq(identityVerificationSessions.deviceIdHash, input.deviceIdHash),
            eq(identityVerificationSessions.status, "VERIFIED"),
            eq(identityVerificationSessions.isFourteenOrOlder, true),
            isNull(identityVerificationSessions.consumedAt),
            gt(identityVerificationSessions.expiresAt, sql`clock_timestamp()`),
          ),
        )
        .limit(1);
      if (!identityCandidate?.ciHash || !identityCandidate.certificateProvider) throw new InvalidFoAuthProofError();
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${identityCandidate.ciHash}, 1))`);
      const [mappingCandidate] = await tx
        .select({ userId: verifiedIdentities.userId })
        .from(verifiedIdentities)
        .where(eq(verifiedIdentities.ciHash, identityCandidate.ciHash))
        .limit(1);
      const [existingUser] = mappingCandidate
        ? await tx.select().from(users).where(eq(users.userId, mappingCandidate.userId)).limit(1).for("update")
        : [];
      if (mappingCandidate && !existingUser) throw new InvalidFoAuthProofError();
      const [currentMapping] = existingUser
        ? await tx
            .select({ userId: verifiedIdentities.userId })
            .from(verifiedIdentities)
            .where(
              and(
                eq(verifiedIdentities.ciHash, identityCandidate.ciHash),
                eq(verifiedIdentities.userId, existingUser.userId),
              ),
            )
            .limit(1)
        : [];
      if (existingUser && !currentMapping) throw new InvalidFoAuthProofError();
      if (existingUser && !hasBuyerCapability(existingUser.role)) throw new InvalidFoAuthProofError();
      const [signup] = await tx
        .update(kakaoSignupTokens)
        .set({ usedAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(kakaoSignupTokens.tokenHash, signupTokenHash),
            eq(kakaoSignupTokens.deviceIdHash, input.deviceIdHash),
            isNull(kakaoSignupTokens.usedAt),
            gt(kakaoSignupTokens.expiresAt, sql`clock_timestamp()`),
          ),
        )
        .returning();
      if (!signup) throw new InvalidFoAuthProofError();
      await tx
        .update(kakaoSignupTokens)
        .set({ usedAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(kakaoSignupTokens.deviceIdHash, input.deviceIdHash),
            ne(kakaoSignupTokens.tokenHash, signup.tokenHash),
            isNull(kakaoSignupTokens.usedAt),
          ),
        );
      const [identity] = await tx
        .update(identityVerificationSessions)
        .set({ consumedAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(identityVerificationSessions.proofTokenHash, identityTokenHash),
            eq(identityVerificationSessions.purpose, "SIGNUP"),
            eq(identityVerificationSessions.deviceIdHash, input.deviceIdHash),
            eq(identityVerificationSessions.status, "VERIFIED"),
            eq(identityVerificationSessions.isFourteenOrOlder, true),
            eq(identityVerificationSessions.ciHash, identityCandidate.ciHash),
            isNull(identityVerificationSessions.consumedAt),
            gt(identityVerificationSessions.expiresAt, sql`clock_timestamp()`),
          ),
        )
        .returning();
      if (!identity?.ciHash || !identity.certificateProvider) throw new InvalidFoAuthProofError();
      const email = signup.emailVerified ? signup.email : input.email;
      if (!email) throw new InvalidFoAuthProofError();
      const emailProof = signup.emailVerified
        ? undefined
        : (
            await tx
              .update(emailVerificationTokens)
              .set({ usedAt: sql`clock_timestamp()` })
              .where(
                and(
                  eq(emailVerificationTokens.tokenHash, hashToken(input.emailVerificationToken ?? "")),
                  eq(emailVerificationTokens.email, email),
                  eq(emailVerificationTokens.purpose, "SIGNUP"),
                  isNull(emailVerificationTokens.usedAt),
                  gt(emailVerificationTokens.expiresAt, sql`clock_timestamp()`),
                ),
              )
              .returning()
          )[0];
      if (!signup.emailVerified && !emailProof) throw new InvalidFoAuthProofError();
      const user =
        existingUser ??
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
      if (!hasBuyerCapability(user.role)) throw new InvalidFoAuthProofError();
      const linkedIdentity = await tx.query.authIdentities.findFirst({
        where: and(eq(authIdentities.provider, "kakao"), eq(authIdentities.providerUserId, signup.providerUserId)),
      });
      if (linkedIdentity && linkedIdentity.userId !== user.userId) throw new InvalidFoAuthProofError();
      if (!existingUser) {
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
