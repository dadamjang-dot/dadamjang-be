# Backend GraphQL API Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 현재 UI 흐름으로 대체된 GraphQL root 3개와 그 전용 상태를 제거하면서 포트폴리오 도메인 API 7개와 실제 사용 중인 인증·이미지·로그아웃 흐름을 보존한다.

**Architecture:** 먼저 링크 기반 비밀번호 복구의 공개 진입점과 런타임 분기를 제거하고 인증코드 proof 하나로 복구 경로를 단일화한다. 다음 커밋에서 신규 PostgreSQL migration으로 링크 전용 테이블과 outbox kind를 제거한 뒤, 독립적인 Media/Push 공개 필드와 BO 프록시의 낡은 허용 목록을 정리한다. Backend와 Frontend는 각 저장소에서 검증·PR·squash merge하고 마지막에 workspace submodule 포인터를 갱신한다.

**Tech Stack:** NestJS, TypeScript, GraphQL, Drizzle ORM, PostgreSQL, Jest, Supertest, Next.js, Vitest, pnpm

**Spec:** `docs/backend-api-cleanup-design.md`

## Global Constraints

- 프론트엔드 UI 부재만으로 Backend API를 삭제하지 않는다.
- `comparison`, `comparisonPriceSummaries`, `addComparisonItem`, `removeComparisonItem`, `applyPartner`, `myActivity`, `updateMarketingConsent`는 유지한다.
- 제거 대상은 `requestPasswordReset`, `productImageUrl`, `unregisterFoPushDevice` 세 root field로 한정한다.
- `MediaService.getProductImageUrl`과 `NotificationRepository.disableInstallation`은 내부 호출이 있으므로 유지한다.
- 비밀번호 복구는 `requestPasswordResetCode` → `verifyPasswordResetCode` → `resetPassword` 흐름과 refresh token 전체 폐기를 유지한다.
- BO BFF는 `requestPasswordResetCode`, `verifyPasswordResetCode`, `resetPassword`를 공개 복구 operation으로 분류한다.
- OAuth·본인인증 callback, health check, activity/feed, outbox worker, GraphQL nested field는 변경하지 않는다.
- 역사적 migration은 수정하지 않고 `0029_remove_password_reset_link.sql`만 추가한다.
- 새 화면, 새 GraphQL 호출, 새 패키지, 새 추상화를 추가하지 않는다.
- TypeScript 함수는 arrow function expression을 사용하고 코드 주석은 추가하지 않는다.
- `docs/superpowers`, `.superpowers`, `CLAUDE.md`를 만들지 않는다.
- 임시 설계·계획 문서는 구현 완료 후 Backend PR에서 제거해 포트폴리오 트리에 남기지 않는다.
- 모든 PR은 `develop` 기준이며 squash merge 후 작업 branch를 삭제한다.

---

## File Map

### Backend runtime

- `src/modules/email/email.resolver.ts`: 비밀번호 복구 GraphQL mutation 진입점
- `src/modules/email/email.types.ts`: email GraphQL input과 delivery kind 계약
- `src/modules/email/email.service.ts`: 인증코드 발급·검증과 비밀번호 재설정 orchestration
- `src/modules/email/email.outbox.ts`: email proof 준비와 provider 발송 분기
- `src/modules/email/email.repository.ts`: email proof 저장·검증·소비 transaction
- `src/modules/database/schema.ts`: Drizzle schema와 outbox 제약 선언
- `src/modules/fo-account/fo-account.repository.ts`: 계정 익명화 시 개인 데이터 정리
- `src/modules/media/media.resolver.ts`: 상품 이미지 upload mutation과 공개 URL query
- `src/modules/media/media.types.ts`: media GraphQL input/output/args 타입
- `src/modules/notification/notification.resolver.ts`: 알림과 Push device GraphQL root
- `src/modules/notification/notification.service.ts`: Push device 등록·해제 서비스

### Backend database and tests

- `migrations/0029_remove_password_reset_link.sql`: legacy link outbox와 token table 제거
- `src/modules/email/email.service.spec.ts`: email service 단위 계약
- `test/graphql.integration-spec.ts`: 최종 GraphQL root 공개 계약
- `test/email-outbox.integration-spec.ts`: 인증코드 outbox 준비·억제·발송·보존
- `test/fo-recovery.integration-spec.ts`: PASSWORD_RESET email proof의 일회성·동시성·세션 폐기
- `test/fo-account-lifecycle.integration-spec.ts`: 익명화와 email outbox lock 순서
- `test/database-migration.integration-spec.ts`: 기존 데이터에서 0029 migration의 결과와 제약
- `test/notification.integration-spec.ts`: Push 등록과 logout 기반 device 해제

### Frontend and workspace

- `../dadamjang-fe/apps/dadamjang-bo/src/_app/api-routes/graphql-operation.ts`: BO BFF의 공개 mutation allowlist
- `../dadamjang-fe/apps/dadamjang-bo/tests/unit/graphql-route.test.ts`: 공개/보호 operation 분류 계약
- workspace의 `dadamjang-be`, `dadamjang-fe` gitlinks: squash merge된 하위 저장소 commit 고정

---

### Task 1: Remove the password-reset link runtime path

**Files:**

- Modify: `src/modules/email/email.resolver.ts:1-49`
- Modify: `src/modules/email/email.types.ts:1-36`
- Modify: `src/modules/email/email.service.ts:29-100`
- Modify: `src/modules/email/email.outbox.ts:93-140`
- Modify: `src/modules/email/email.repository.ts:13-178,255-389,494-583`
- Modify: `src/modules/email/email.service.spec.ts:102-185`
- Modify: `test/graphql.integration-spec.ts:198-205`
- Modify: `test/email-outbox.integration-spec.ts:47-160,297-310,425-434,503-512`
- Modify: `test/fo-recovery.integration-spec.ts:20-73,153-419,506-519`
- Modify: `test/fo-account-lifecycle.integration-spec.ts:354-357,1520-1523,1607-1611`

**Interfaces:**

- Consumes: `emailVerificationToken(tokenHash, email, purpose, verificationId, expiresAt, usedAt)` and `EmailVerificationPurpose.PasswordReset`.
- Produces: `EmailDeliveryKindValue = "SIGNUP_CODE" | "PASSWORD_RESET_CODE" | "ADMIN_INVITE"`.
- Produces: `EmailRepository.hasValidRecoveryToken(token: string): Promise<boolean>` backed only by `emailVerificationTokens` with purpose `PASSWORD_RESET`.
- Produces: `EmailRepository.resetPasswordWithToken(token: string, password: string): Promise<boolean>` consuming one email proof, expiring sibling reset proofs/codes, and deleting every refresh token.
- Preserves: `EmailDeliveryWorker` code delivery and admin invite link delivery.

- [ ] **Step 1: Add the failing GraphQL root contract**

Replace the narrow activity-only introspection case with two assertions: retain the intentional portfolio roots and remove only the legacy reset-link mutation. Keep the separate `recordActivity` assertion in the same test.

```ts
it("keeps intentional portfolio roots and omits legacy password-reset links", async () => {
  const response = await request(app.getHttpServer()).post("/graphql").send({
    query: `query ApiFields {
      __schema {
        queryType { fields { name } }
        mutationType { fields { name } }
      }
    }`,
  });
  const queryFields = response.body.data.__schema.queryType.fields.map((field: { name: string }) => field.name);
  const mutationFields = response.body.data.__schema.mutationType.fields.map((field: { name: string }) => field.name);

  expect(queryFields).toEqual(expect.arrayContaining(["comparison", "comparisonPriceSummaries", "myActivity"]));
  expect(mutationFields).toEqual(
    expect.arrayContaining([
      "addComparisonItem",
      "removeComparisonItem",
      "applyPartner",
      "updateMarketingConsent",
    ]),
  );
  expect(mutationFields).not.toContain("requestPasswordReset");
  expect(mutationFields).not.toContain("recordActivity");
});
```

- [ ] **Step 2: Run the contract test and confirm the legacy field is still exposed**

Run:

```bash
pnpm db:test:up
pnpm test:integration -- --runTestsByPath test/graphql.integration-spec.ts -t "keeps intentional portfolio roots"
```

Expected: FAIL because `mutationFields` contains `requestPasswordReset`; all seven retained field assertions pass.

- [ ] **Step 3: Delete the resolver, input, service, outbox, and repository link branches**

Make `email.types.ts` expose only the live delivery kinds and inputs:

```ts
export const EmailDeliveryKind = {
  SignupCode: "SIGNUP_CODE",
  PasswordResetCode: "PASSWORD_RESET_CODE",
  AdminInvite: "ADMIN_INVITE",
} as const;

export type EmailDeliveryKindValue = (typeof EmailDeliveryKind)[keyof typeof EmailDeliveryKind];

@InputType()
export class RequestEmailCodeInput {
  @Field() email!: string;
}

@InputType()
export class VerifyEmailCodeInput {
  @Field() email!: string;
  @Field() code!: string;
}

@InputType()
export class ResetPasswordInput {
  @Field() token!: string;
  @Field() password!: string;
}
```

Delete `RequestPasswordResetInput` from `email.resolver.ts` imports and delete its `requestPasswordReset` method. Delete `EmailService.requestPasswordReset`; keep `requestPasswordResetCode` delegating to `requestRecoveryCode`.

Make `EmailDeliveryWorker.prepare` always create a six-digit code for non-invite work, while retaining `randomBytes` because payload encryption still needs a nonce:

```ts
private prepare = async (claimed: NonNullable<Awaited<ReturnType<EmailRepository["claimDelivery"]>>>, now: Date) => {
  if (claimed.payloadCiphertext && claimed.proofId)
    return { ...claimed, payloadCiphertext: claimed.payloadCiphertext, proofId: claimed.proofId };
  if (claimed.kind === EmailDeliveryKind.AdminInvite) throw new Error("Admin invite payload is missing");
  const purpose =
    claimed.kind === EmailDeliveryKind.SignupCode
      ? EmailVerificationPurpose.Signup
      : EmailVerificationPurpose.PasswordReset;
  const secret = String(randomInt(1_000_000)).padStart(6, "0");
  const pepper = this.configService.getOrThrow<string>("EMAIL_CODE_PEPPER");
  const payloadCiphertext = encryptEmailPayload(secret, pepper);
  const proofExpiresAt = new Date(now.getTime() + 5 * 60_000);
  const codeHash = await bcrypt.hash(emailCodeSecret(claimed.email, secret, purpose, pepper), 10);
  return this.repository.prepareDelivery(claimed, { codeHash, payloadCiphertext, proofExpiresAt }, now);
};

private send = async (id: string, kind: string, email: string, secret: string) => {
  const idempotencyKey = `email-delivery/${id}`;
  if (kind === EmailDeliveryKind.SignupCode || kind === EmailDeliveryKind.PasswordResetCode)
    return this.sender.sendCode(email, secret, idempotencyKey);
  const boUrl = this.configService.getOrThrow<string>("DADAMJANG_BO_URL").replace(/\/$/, "");
  return this.sender.sendLink(email, "다담장 관리자 초대", `${boUrl}/invite/accept#token=${secret}`, idempotencyKey);
};
```

Remove `passwordResetTokens` from `email.repository.ts` and make preparation code-only:

```ts
type DeliveryPreparation = Readonly<{
  codeHash: string;
  payloadCiphertext: string;
  proofExpiresAt: Date;
}>;
```

```ts
hasValidRecoveryToken = async (token: string) => {
  const [emailProof] = await this.db
    .select({ tokenHash: emailVerificationTokens.tokenHash })
    .from(emailVerificationTokens)
    .where(
      and(
        eq(emailVerificationTokens.tokenHash, hashToken(token)),
        eq(emailVerificationTokens.purpose, "PASSWORD_RESET"),
        isNull(emailVerificationTokens.usedAt),
        gt(emailVerificationTokens.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return !!emailProof;
};
```

Replace the conditional proof insert inside `prepareDelivery` with one `emailVerifications` insert:

```ts
const verification = requireResult(
  (
    await tx
      .insert(emailVerifications)
      .values({
        email: delivery.email,
        purpose,
        codeHash: preparation.codeHash,
        expiresAt: preparation.proofExpiresAt,
        requestIpHash: delivery.requestIpHash,
      })
      .returning({ id: emailVerifications.id })
  )[0],
);
const proofId = verification.id;
```

Delete the `PasswordResetLink` branch from `isDeliveryCurrent`. Replace `resetPasswordWithToken` lookup and consumption with the email-proof-only form below; retain the existing updates that consume sibling `emailVerificationTokens`, expire unverified reset codes, and delete `refreshTokens`.

```ts
const lookupAt = new Date();
const tokenHash = hashToken(token);
const [emailProof] = await tx
  .select({ userId: users.userId })
  .from(emailVerificationTokens)
  .innerJoin(users, eq(users.email, emailVerificationTokens.email))
  .where(
    and(
      eq(emailVerificationTokens.tokenHash, tokenHash),
      eq(emailVerificationTokens.purpose, "PASSWORD_RESET"),
      isNull(emailVerificationTokens.usedAt),
      gt(emailVerificationTokens.expiresAt, lookupAt),
    ),
  )
  .limit(1);
if (!emailProof) return false;
const [user] = await tx.select().from(users).where(eq(users.userId, emailProof.userId)).for("update");
if (!user || user.password === null) return false;
const now = new Date();
const [consumedProof] = await tx
  .update(emailVerificationTokens)
  .set({ usedAt: now })
  .where(
    and(
      eq(emailVerificationTokens.tokenHash, tokenHash),
      eq(emailVerificationTokens.email, user.email),
      eq(emailVerificationTokens.purpose, "PASSWORD_RESET"),
      isNull(emailVerificationTokens.usedAt),
      gt(emailVerificationTokens.expiresAt, now),
    ),
  )
  .returning({ tokenHash: emailVerificationTokens.tokenHash });
if (!consumedProof) return false;
```

- [ ] **Step 4: Rewrite recovery tests around the one live proof model**

In `email.service.spec.ts`, delete `rejects link admission before account lookup or delivery work`. Change the generic queue test to call `requestPasswordResetCode` for one known and one unknown address and expect exactly two `PASSWORD_RESET_CODE` kinds:

```ts
await expect(
  Promise.all([
    service.requestPasswordResetCode("user@example.test", { ip: "127.0.0.1" }),
    service.requestPasswordResetCode("unknown@example.test", { ip: "127.0.0.2" }),
  ]),
).resolves.toEqual([{ ok: true }, { ok: true }]);
expect(enqueueDelivery.mock.calls.map(([input]) => input.kind)).toEqual([
  "PASSWORD_RESET_CODE",
  "PASSWORD_RESET_CODE",
]);
```

In `fo-recovery.integration-spec.ts`, replace link-table setup with this local helper and use a unique UUID per proof:

```ts
const seedPasswordResetProof = async (
  pool: Pool,
  token: string,
  verificationId: string,
  expiresAt = new Date(Date.now() + 10 * 60_000),
) => {
  await pool.query(
    `INSERT INTO "emailVerification" ("id", "email", "purpose", "codeHash", "expiresAt", "verifiedAt")
     VALUES ($1, 'integration@example.test', 'PASSWORD_RESET', 'verified-proof', $2, now())`,
    [verificationId, expiresAt],
  );
  await pool.query(
    `INSERT INTO "emailVerificationToken" ("tokenHash", "email", "purpose", "verificationId", "expiresAt")
     VALUES ($1, 'integration@example.test', 'PASSWORD_RESET', $2, $3)`,
    [hashToken(token), verificationId, expiresAt],
  );
};
```

Apply these exact test conversions:

- `installResetRaceDelay` and `removeResetRaceDelay`: retain only the `emailVerificationToken` trigger.
- `seedResetRace`: seed `race-email-a` and `race-email-b` with UUID suffixes `10` and `11`, plus the existing refresh token.
- Passwordless, empty-password, expiry, and rollback cases: call `seedPasswordResetProof` instead of inserting `passwordResetToken`; query `emailVerificationToken.usedAt` by `tokenHash`.
- Sibling revocation: seed `primary-reset-proof` and `sibling-code-proof` as two email proofs, retain the active unverified code, then expect `{ emailProofs: 0, codes: 0, refreshTokens: 0 }` and reject the sibling proof.
- Concurrency: replace the three link/email matrix rows with one case using `race-email-a` and `race-email-b`; still require exactly one success, one `UNAUTHENTICATED` failure, no active proof, and no refresh token.
- Delete only the test named `returns the same password reset link response for known and unknown emails`.

The passwordless state assertion becomes:

```ts
const state = await pool.query<{ password: string | null; usedAt: Date | null }>(
  `SELECT u."password", p."usedAt"
   FROM "users" u
   JOIN "emailVerificationToken" p ON p."email" = u."email"
   WHERE u."userId" = $1 AND p."tokenHash" = $2`,
  [FIXTURE.userId, hashToken("stale-passwordless-proof")],
);
expect(state.rows[0]).toEqual({ password: null, usedAt: null });
```

In `email-outbox.integration-spec.ts`, keep both account-shape edge cases but issue reset codes through `requestEmail`:

```ts
const sendCode = jest.spyOn(sender, "sendCode").mockResolvedValue(undefined);
const requested = await requestEmail(
  app,
  "requestPasswordResetCode",
  "integration@example.test",
  "passwordless-reset-device",
);
expect(requested.body).toEqual({ data: { requestPasswordResetCode: { ok: true } } });
await worker.runOnce(new Date(Date.now() + 1_000));
expect(sendCode).not.toHaveBeenCalled();
expect(rows.rows).toEqual([{ kind: "PASSWORD_RESET_CODE", status: "SUPPRESSED" }]);
```

Use the same mutation for the empty-but-non-null password case and expect `sendCode` once. Replace `PASSWORD_RESET_LINK` with `PASSWORD_RESET_CODE` in terminal scrub/purge fixtures because those tests exercise status retention, not link behavior.

Replace all three generic lifecycle literals with `PASSWORD_RESET_CODE`; for the anonymization fixture use `fixture.verificationId` as `proofId`:

```ts
await client.query(
  `INSERT INTO "emailDeliveryOutbox" (id, kind, email, "payloadCiphertext", "proofId", status, "expiresAt")
   VALUES ($1, 'PASSWORD_RESET_CODE', $2, 'anonymization-ciphertext', $3, 'PENDING', now() + interval '10 minutes')`,
  [fixture.outboxId, fixture.email, fixture.verificationId],
);
```

- [ ] **Step 5: Run focused unit and integration checks**

Run:

```bash
pnpm test:unit -- --runTestsByPath src/modules/email/email.service.spec.ts src/modules/email/email.outbox.spec.ts
pnpm test:integration -- --runTestsByPath test/graphql.integration-spec.ts test/email-outbox.integration-spec.ts test/fo-recovery.integration-spec.ts test/fo-account-lifecycle.integration-spec.ts
pnpm build
```

Expected: all selected suites PASS and Nest build completes without `RequestPasswordResetInput`, `PasswordResetLink`, or `requestPasswordReset` references.

- [ ] **Step 6: Commit the runtime cleanup**

```bash
git add src/modules/email src/modules/fo-account/fo-account.repository.ts test/graphql.integration-spec.ts test/email-outbox.integration-spec.ts test/fo-recovery.integration-spec.ts test/fo-account-lifecycle.integration-spec.ts
git commit -m "refactor(auth): remove password reset link flow"
```

---

### Task 2: Drop legacy password-link database state

**Files:**

- Create: `migrations/0029_remove_password_reset_link.sql`
- Modify: `src/modules/database/schema.ts:296-305,349-352,1040-1045`
- Modify: `src/modules/fo-account/fo-account.repository.ts:11-35,117-128,148-160`
- Modify: `test/database-migration.integration-spec.ts:10-23,192-246`
- Modify: `test/fo-account-lifecycle.integration-spec.ts:339-357,1265-1301`

**Interfaces:**

- Consumes: Task 1's email-proof-only runtime and `PASSWORD_RESET_CODE` outbox fixtures.
- Produces: database schema without table `passwordResetToken`.
- Produces: `email_delivery_outbox_kind_check` accepting only `SIGNUP_CODE`, `PASSWORD_RESET_CODE`, and `ADMIN_INVITE`.
- Produces: account anonymization proof locking and cleanup based only on `emailVerification.id` and `emailVerificationToken`.

- [ ] **Step 1: Add a migration test that seeds state immediately before 0029**

Add the migration name near the existing constants:

```ts
const PASSWORD_RESET_LINK_CLEANUP_MIGRATION = "0029_remove_password_reset_link.sql";
```

Add this integration case after the empty-database migration case:

```ts
it("removes legacy password-link state and preserves active email delivery kinds", async () => {
  let seededLegacyState = false;
  await migrate({
    pool: migrationPool,
    beforeMigration: async (name, pool) => {
      if (name !== PASSWORD_RESET_LINK_CLEANUP_MIGRATION) return;
      seededLegacyState = true;
      await pool.query(
        `INSERT INTO "users" ("userId", "userid", "email", "password")
         VALUES ('10000000-0000-4000-8000-000000000099', 'legacy-reset-user', 'legacy-reset@example.test', 'hash')`,
      );
      await pool.query(
        `INSERT INTO "passwordResetToken" ("tokenHash", "userId", "expiresAt")
         VALUES ('legacy-reset-token', '10000000-0000-4000-8000-000000000099', now() + interval '10 minutes')`,
      );
      await pool.query(
        `INSERT INTO "emailDeliveryOutbox" ("kind", "email", "expiresAt") VALUES
          ('PASSWORD_RESET_LINK', 'legacy-link@example.test', now() + interval '10 minutes'),
          ('SIGNUP_CODE', 'signup@example.test', now() + interval '10 minutes'),
          ('PASSWORD_RESET_CODE', 'reset-code@example.test', now() + interval '10 minutes'),
          ('ADMIN_INVITE', 'invite@example.test', now() + interval '10 minutes')`,
      );
    },
  });

  expect(seededLegacyState).toBe(true);
  const state = await migrationPool.query<{
    kinds: string[];
    legacyLinks: number;
    passwordResetTable: string | null;
  }>(
    `SELECT
       to_regclass('public."passwordResetToken"')::text AS "passwordResetTable",
       count(*) FILTER (WHERE "kind" = 'PASSWORD_RESET_LINK')::int AS "legacyLinks",
       array_agg("kind" ORDER BY "kind") AS "kinds"
     FROM "emailDeliveryOutbox"`,
  );
  expect(state.rows[0]).toEqual({
    kinds: ["ADMIN_INVITE", "PASSWORD_RESET_CODE", "SIGNUP_CODE"],
    legacyLinks: 0,
    passwordResetTable: null,
  });
  await expectConstraintError(
    () =>
      migrationPool.query(
        `INSERT INTO "emailDeliveryOutbox" ("kind", "email", "expiresAt")
         VALUES ('PASSWORD_RESET_LINK', 'rejected@example.test', now() + interval '10 minutes')`,
      ),
    "23514",
    "email_delivery_outbox_kind_check",
  );
});
```

- [ ] **Step 2: Run the migration case and confirm 0029 is absent**

Run:

```bash
pnpm test:integration -- --runTestsByPath test/database-migration.integration-spec.ts -t "removes legacy password-link state"
```

Expected: FAIL because `seededLegacyState` remains `false` and `passwordResetToken` still exists.

- [ ] **Step 3: Add 0029 and align the Drizzle schema**

Create `migrations/0029_remove_password_reset_link.sql` with exactly:

```sql
DELETE FROM "emailDeliveryOutbox"
WHERE "kind" = 'PASSWORD_RESET_LINK';

ALTER TABLE "emailDeliveryOutbox"
  DROP CONSTRAINT "email_delivery_outbox_kind_check";

ALTER TABLE "emailDeliveryOutbox"
  ADD CONSTRAINT "email_delivery_outbox_kind_check"
  CHECK ("kind" IN ('SIGNUP_CODE', 'PASSWORD_RESET_CODE', 'ADMIN_INVITE'));

DROP TABLE "passwordResetToken";
```

Delete the `passwordResetTokens` Drizzle table and `PasswordResetToken` inferred type. Change the live schema check to:

```ts
check(
  "email_delivery_outbox_kind_check",
  sql`${table.kind} IN ('SIGNUP_CODE', 'PASSWORD_RESET_CODE', 'ADMIN_INVITE')`,
),
```

Do not edit `migrations/0000_initial_schema.sql` or `migrations/0017_email_delivery_outbox.sql`.

- [ ] **Step 4: Remove legacy token handling from account anonymization fixtures and code**

Remove `passwordResetTokens` from `fo-account.repository.ts`. Build `proofIds` directly from verification rows:

```ts
const verificationProofs = await tx
  .select({ id: emailVerifications.id })
  .from(emailVerifications)
  .where(eq(emailVerifications.email, user.email));
const proofIds = verificationProofs.map(({ id }) => id);
```

Delete the `tx.delete(passwordResetTokens)` call. In `seedAnonymizationFixture`, delete the `passwordResetToken` insert. In the personal-row assertion, delete the `passwordResetTokens` subquery, result key, and expected value; keep assertions for `emailVerificationTokens`, `emailVerifications`, and `emailOutbox` at zero.

- [ ] **Step 5: Run migration, lifecycle, static-reference, and build checks**

Run:

```bash
pnpm test:integration -- --runTestsByPath test/database-migration.integration-spec.ts test/fo-account-lifecycle.integration-spec.ts
pnpm build
rg -n 'passwordResetTokens|PasswordResetToken' src test
```

Expected: both suites PASS, build succeeds, and `rg` returns no matches. `passwordResetToken` remains only in historical migration `0000`, cleanup migration `0029`, and the migration test that seeds pre-0029 state.

- [ ] **Step 6: Commit the persistence cleanup**

```bash
git add migrations/0029_remove_password_reset_link.sql src/modules/database/schema.ts src/modules/fo-account/fo-account.repository.ts test/database-migration.integration-spec.ts test/fo-account-lifecycle.integration-spec.ts
git commit -m "refactor(auth): drop legacy reset token storage"
```

---

### Task 3: Remove duplicate Media and Push GraphQL roots

**Files:**

- Modify: `test/graphql.integration-spec.ts:198-220`
- Modify: `src/modules/media/media.resolver.ts:1-58`
- Modify: `src/modules/media/media.types.ts:1-49`
- Modify: `src/modules/notification/notification.resolver.ts:64-72`
- Modify: `src/modules/notification/notification.service.ts:188-206`
- Modify: `test/notification.integration-spec.ts:863-883`

**Interfaces:**

- Consumes: `MediaService.getProductImageUrl(key: string, width?: number): string` from Catalog and Partner services.
- Consumes: `NotificationRepository.disableInstallation(store, userId, installationId, reason)` from `AuthRepository.logout`.
- Produces: GraphQL schema without query `productImageUrl` and mutation `unregisterFoPushDevice`.
- Preserves: `createProductImageUpload`, `createStylePostImageUpload`, `registerFoPushDevice`, notification preferences, and logout device disablement.

- [ ] **Step 1: Add a failing schema contract for both duplicate roots**

Add this test beside the portfolio root contract:

```ts
it("does not expose duplicate media or push-device roots", async () => {
  const response = await request(app.getHttpServer()).post("/graphql").send({
    query: `query ApiFields {
      __schema {
        queryType { fields { name } }
        mutationType { fields { name } }
      }
    }`,
  });
  const queryFields = response.body.data.__schema.queryType.fields.map((field: { name: string }) => field.name);
  const mutationFields = response.body.data.__schema.mutationType.fields.map((field: { name: string }) => field.name);

  expect(queryFields).not.toContain("productImageUrl");
  expect(mutationFields).not.toContain("unregisterFoPushDevice");
});
```

- [ ] **Step 2: Run the contract test and confirm both fields are exposed**

Run:

```bash
pnpm test:integration -- --runTestsByPath test/graphql.integration-spec.ts -t "does not expose duplicate media"
```

Expected: FAIL because both arrays still contain the removed field names.

- [ ] **Step 3: Delete only the public resolver surface and its dead service method**

In `media.resolver.ts`, remove `Query` from the GraphQL import, remove `ProductImageUrlArgs`, and delete the `productImageUrl` method. The class must end after `createStylePostImageUpload`:

```ts
@Mutation(() => ProductImageUploadTarget)
@Roles(UserRole.User, UserRole.Partner)
async createStylePostImageUpload(
  @Args("input") input: CreateStylePostImageUploadInput,
  @Context() context: MediaContext,
) {
  const { req, userId } = currentRequest(context);
  return this.mediaService.createStylePostUpload(userId, input, requestOriginFromRequest(req));
}
```

In `media.types.ts`, remove `ArgsType` from the import and delete `ProductImageUrlArgs`. Keep `Int` because both upload inputs still use it.

In `notification.resolver.ts`, delete only:

```ts
@Mutation(() => Boolean)
unregisterFoPushDevice(@Context("req") req: AuthRequest) {
  return this.service.unregisterDevice(req.user.userId, deviceIdFromRequest(req));
}
```

Keep `deviceIdFromRequest` because `registerFoPushDevice` uses it. Delete `NotificationService.unregisterDevice`; do not change `NotificationRepository.disableInstallation` or `AuthRepository.logout`.

- [ ] **Step 4: Remove the obsolete unregister integration case**

Delete only `disables a device and terminally fails unsettled deliveries on unregister` from `test/notification.integration-spec.ts`. Keep `deletes the refresh session and disables its Push delivery state in one logout`, which is the live user flow and must continue asserting disabled deliveries.

- [ ] **Step 5: Run schema, internal media, and logout checks**

Run:

```bash
pnpm test:unit -- --runTestsByPath src/modules/media/media.service.spec.ts src/modules/media/media.security.spec.ts src/modules/media/media.sdk-wire.spec.ts src/modules/catalog/catalog.service.spec.ts src/modules/partner/partner.service.spec.ts
pnpm test:integration -- --runTestsByPath test/graphql.integration-spec.ts test/notification.integration-spec.ts
pnpm build
rg -n 'getProductImageUrl|disableInstallation' src/modules/catalog src/modules/partner src/modules/media src/modules/auth src/modules/notification
```

Expected: tests and build PASS. The final `rg` still shows Catalog/Partner calls to `getProductImageUrl`, its Media implementation, Auth logout's `disableInstallation` call, and the repository implementation; it shows no resolver call for either removed field.

- [ ] **Step 6: Commit the duplicate-root cleanup**

```bash
git add src/modules/media src/modules/notification/notification.resolver.ts src/modules/notification/notification.service.ts test/graphql.integration-spec.ts test/notification.integration-spec.ts
git commit -m "refactor(api): remove duplicate media and push fields"
```

---

### Task 4: Align the BO proxy with code-based password recovery

**Files:**

- Modify: `../dadamjang-fe/apps/dadamjang-bo/src/_app/api-routes/graphql-operation.ts:10-16`
- Modify: `../dadamjang-fe/apps/dadamjang-bo/tests/unit/graphql-route.test.ts:711-769`

**Interfaces:**

- Consumes: Backend schema from Tasks 1-3 where `requestPasswordReset` no longer exists.
- Produces: `isPublicOperation(payload: Record<string, unknown>): boolean` classifying `requestPasswordResetCode` and `verifyPasswordResetCode` as public (`true`) and the removed mutation as protected/unknown (`false`).
- Preserves: public `signin`, `refresh`, `acceptAdminInvite`, and `resetPassword` operation classification.

- [ ] **Step 1: Create the Frontend branch from develop**

Run from `../dadamjang-fe`:

```bash
git switch develop
git pull --ff-only origin develop
git switch -c refactor/prune-unused-graphql-apis
```

Expected: branch `refactor/prune-unused-graphql-apis` starts at current `origin/develop` with a clean worktree.

- [ ] **Step 2: Add failing live and legacy recovery classification rows**

Add these rows to the `it.each` table:

```ts
[
  true,
  "mutation RequestResetCode { requestPasswordResetCode(input: {}) { ok } }",
  undefined,
],
[
  true,
  "mutation VerifyResetCode { verifyPasswordResetCode(input: {}) { emailVerificationToken } }",
  undefined,
],
[
  false,
  "mutation LegacyReset { requestPasswordReset(input: {}) { ok } }",
  undefined,
],
```

- [ ] **Step 3: Run the focused Vitest file and confirm the allowlist is stale**

Run:

```bash
pnpm --dir apps/dadamjang-bo test tests/unit/graphql-route.test.ts
```

Expected: FAIL because the two code-based operations return `false` and legacy `requestPasswordReset` returns `true`.

- [ ] **Step 4: Remove the stale field from the public allowlist**

Make the set exactly:

```ts
const PUBLIC_FIELDS = new Set([
  "signin",
  "refresh",
  "acceptAdminInvite",
  "requestPasswordResetCode",
  "verifyPasswordResetCode",
  "resetPassword",
]);
```

Do not modify the BO forgot-password page: it already uses `requestPasswordResetCode`, `verifyPasswordResetCode`, and `resetPassword`.

- [ ] **Step 5: Run focused and full BO checks**

Run:

```bash
pnpm --dir apps/dadamjang-bo test tests/unit/graphql-route.test.ts
pnpm bo:lint
pnpm bo:typecheck
pnpm bo:test
pnpm bo:build
```

Expected: all commands PASS; the two operations used by the code-based forgot-password UI classify as public and the removed link operation classifies as false.

- [ ] **Step 6: Commit the Frontend cleanup**

```bash
git add apps/dadamjang-bo/src/_app/api-routes/graphql-operation.ts apps/dadamjang-bo/tests/unit/graphql-route.test.ts
git commit -m "fix(auth): classify code recovery operations as public"
```

---

### Task 5: Verify, remove process artifacts, and deliver all repositories

**Files:**

- Delete: `docs/backend-api-cleanup-design.md`
- Delete: `docs/backend-api-cleanup-plan.md`
- Modify: workspace gitlink `dadamjang-be`
- Modify: workspace gitlink `dadamjang-fe`

**Interfaces:**

- Consumes: Backend commits from Tasks 1-3 and Frontend commit from Task 4.
- Produces: merged Backend and Frontend `develop` commits plus one workspace commit pinning both.
- Produces: a portfolio tree with no temporary API-cleanup process documents.

- [ ] **Step 1: Run the complete Backend verification matrix**

Run from `dadamjang-be`:

```bash
pnpm lint
pnpm build
pnpm test:unit
pnpm db:test:up
pnpm test:integration
```

Expected: lint, build, every unit suite, and every integration suite PASS.

- [ ] **Step 2: Verify exact deletion and preservation boundaries**

Run from `dadamjang-be`:

```bash
rg -n '\brequestPasswordReset\b|RequestPasswordResetInput|PasswordResetLink|productImageUrl|ProductImageUrlArgs|unregisterFoPushDevice|unregisterDevice|passwordResetTokens|PasswordResetToken' src
rg -n 'comparisonPriceSummaries|addComparisonItem|removeComparisonItem|applyPartner|myActivity|updateMarketingConsent|getProductImageUrl|disableInstallation' src
rg -n 'PASSWORD_RESET_LINK|passwordResetToken' migrations test/database-migration.integration-spec.ts
```

Expected:

- First command returns no matches.
- Second command shows all seven retained API names plus internal image URL and logout device-disable paths.
- Third command shows legacy names only in historical migrations, `0029_remove_password_reset_link.sql`, and the migration compatibility test.

- [ ] **Step 3: Remove temporary Backend design and plan documents and commit**

Delete both files with an `apply_patch` delete operation, then run:

```bash
git add -u docs/backend-api-cleanup-design.md docs/backend-api-cleanup-plan.md
git commit -m "chore(api): remove temporary planning docs"
git status --short
```

Expected: commit succeeds and `git status --short` is empty.

- [ ] **Step 4: Re-run the complete BO verification matrix and inspect both diffs**

Run from `../dadamjang-fe`:

```bash
pnpm bo:lint
pnpm bo:typecheck
pnpm bo:test
pnpm bo:build
git diff --check develop...HEAD
```

Run from `../dadamjang-be`:

```bash
git diff --check develop...HEAD
git status --short
```

Expected: every command PASS, both diff checks return no output, and Backend status is clean.

- [ ] **Step 5: Push, review, and squash-merge the Backend PR**

Run from `dadamjang-be`:

```bash
git push -u origin refactor/prune-unused-graphql-apis
gh pr create --base develop --head refactor/prune-unused-graphql-apis --title "refactor(api): remove replaced graphql APIs" --body "Removes the reset-link, direct image URL, and direct push-unregister GraphQL roots while preserving intentional portfolio APIs and live UI flows."
gh pr checks --watch
gh pr merge --squash --delete-branch
git switch develop
git pull --ff-only origin develop
```

Expected: checks PASS, PR is squash merged into `develop`, remote feature branch is deleted, and local `develop` points at the merge commit.

- [ ] **Step 6: Push, review, and squash-merge the Frontend PR**

Run from `../dadamjang-fe`:

```bash
git push -u origin refactor/prune-unused-graphql-apis
gh pr create --base develop --head refactor/prune-unused-graphql-apis --title "fix(auth): align password recovery operations" --body "Replaces the retired reset-link operation in the BO proxy allowlist with the code request and verification operations used by the current UI."
gh pr checks --watch
gh pr merge --squash --delete-branch
git switch develop
git pull --ff-only origin develop
```

Expected: checks PASS, PR is squash merged into `develop`, remote feature branch is deleted, and local `develop` points at the merge commit.

- [ ] **Step 7: Commit and squash-merge the workspace submodule pointers**

Run from the workspace root:

```bash
git switch develop
git pull --ff-only origin develop
git switch -c chore/update-api-cleanup-submodules
git add dadamjang-be dadamjang-fe
git commit -m "chore(workspace): update api cleanup submodules"
git diff --check develop...HEAD
git push -u origin chore/update-api-cleanup-submodules
gh pr create --base develop --head chore/update-api-cleanup-submodules --title "chore(workspace): update api cleanup submodules" --body "Pins the Backend and Frontend commits that remove replaced GraphQL API surfaces."
gh pr checks --watch
gh pr merge --squash --delete-branch
git switch develop
git pull --ff-only origin develop
git status --short --branch
```

Expected: workspace PR is squash merged, the workspace tracks the merged Backend and Frontend commits, and final status is clean on `develop`.

- [ ] **Step 8: Stop the test database and verify branch cleanup**

Run from `dadamjang-be`:

```bash
pnpm db:test:down
git branch --list refactor/prune-unused-graphql-apis
```

Run from `../dadamjang-fe`:

```bash
git branch --list refactor/prune-unused-graphql-apis
```

Run from the workspace root:

```bash
git branch --list chore/update-api-cleanup-submodules
```

Expected: test PostgreSQL stops and each branch-list command returns no output. If a Backend or Frontend local branch remains, run `git branch -d refactor/prune-unused-graphql-apis`; if the workspace local branch remains, run `git branch -d chore/update-api-cleanup-submodules`. Rerun the corresponding branch-list command afterward.
