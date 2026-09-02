import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as bcrypt from "bcrypt";
import { createHash, createHmac } from "crypto";
import {
  CustomBadRequestException,
  CustomTooManyRequestsException,
  CustomUnauthorizedException,
} from "src/common/errors/custom-exceptions";
import { AdmissionLimiter, type AdmissionRule, type RequestOrigin } from "src/modules/admission/admission-limiter";
import type { DatabaseTransaction } from "src/modules/database/database.module";
import { EmailErrorMessage } from "./email.error";
import { emailCodeSecret, encryptEmailPayload } from "./email.outbox";
import { EmailRepository } from "./email.repository";
import {
  EmailDeliveryKind,
  EmailVerificationPurpose,
  type EmailDeliveryKindValue,
  type EmailVerificationPurposeValue,
} from "./email.types";

@Injectable()
export class EmailService {
  constructor(
    private readonly repository: EmailRepository,
    private readonly configService: ConfigService,
    private readonly admissionLimiter: AdmissionLimiter,
  ) {}
  requestSignupCode = async (email: string, origin: RequestOrigin) => {
    const normalizedEmail = this.normalizeEmail(email);
    await this.admitEmailDelivery(normalizedEmail, origin);
    await this.queueDelivery(normalizedEmail, origin.ip, EmailDeliveryKind.SignupCode, 10 * 60_000);
    return { ok: true };
  };
  requestPasswordResetCode = (email: string, origin: RequestOrigin) => this.requestRecoveryCode(email, origin);
  verifySignupCode = (email: string, code: string, origin: RequestOrigin = { ip: "unknown" }) =>
    this.verifyCode(email, code, EmailVerificationPurpose.Signup, origin);
  verifyPasswordResetCode = (email: string, code: string, origin: RequestOrigin = { ip: "unknown" }) =>
    this.verifyCode(email, code, EmailVerificationPurpose.PasswordReset, origin);
  private requestRecoveryCode = async (email: string, origin: RequestOrigin) => {
    const normalizedEmail = this.normalizeEmail(email);
    await this.admitEmailDelivery(normalizedEmail, origin);
    await this.queueDelivery(normalizedEmail, origin.ip, EmailDeliveryKind.PasswordResetCode, 10 * 60_000);
    return { ok: true };
  };
  private verifyCode = async (
    email: string,
    code: string,
    purpose: EmailVerificationPurposeValue,
    origin: RequestOrigin,
  ) => {
    const normalizedEmail = this.normalizeEmail(email);
    await this.admissionLimiter.assertAllowed(
      "EMAIL_CODE_VERIFY",
      this.admissionRules(normalizedEmail, origin, 5, 15 * 60_000, "verify"),
      EmailErrorMessage.RequestLimitExceeded,
    );
    const verification = await this.repository.latestVerification(normalizedEmail, purpose);
    if (!verification) throw new CustomUnauthorizedException(EmailErrorMessage.InvalidCode);
    if (!verification.verifiedAt && verification.expiresAt.getTime() <= Date.now())
      throw new CustomUnauthorizedException(EmailErrorMessage.ExpiredCode);
    if (!verification.verifiedAt && verification.attemptCount >= 5)
      throw new CustomTooManyRequestsException(EmailErrorMessage.CodeAttemptLimitExceeded);
    if (!(await bcrypt.compare(this.pepperedCode(normalizedEmail, code, purpose), verification.codeHash))) {
      await this.repository.incrementAttempt(verification.id);
      throw new CustomUnauthorizedException(EmailErrorMessage.InvalidCode);
    }
    const token = this.proofToken(verification.id);
    const proof = await this.repository.verifyAndCreateProof({
      email: normalizedEmail,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      purpose,
      token,
      verificationId: verification.id,
    });
    if (!proof) throw new CustomUnauthorizedException(EmailErrorMessage.InvalidCode);
    return { emailVerificationToken: token };
  };
  resetPassword = async (token: string, password: string, origin: RequestOrigin = { ip: "unknown" }) => {
    this.assertPassword(password);
    await this.admissionLimiter.assertAllowed(
      "PASSWORD_RESET",
      [
        { scopeType: "token", value: token, limit: 5, windowMs: 15 * 60_000 },
        ...this.requesterRules(origin, 20, 15 * 60_000, "reset"),
      ],
      EmailErrorMessage.RequestLimitExceeded,
    );
    if (!(await this.repository.hasValidRecoveryToken(token)))
      throw new CustomUnauthorizedException(EmailErrorMessage.InvalidRecoveryToken);
    const reset = await this.repository.resetPasswordWithToken(token, await bcrypt.hash(password, 10));
    if (!reset) throw new CustomUnauthorizedException(EmailErrorMessage.InvalidRecoveryToken);
    return { ok: true };
  };
  consumeVerifiedEmailToken = async (token: string, email: string, transaction?: DatabaseTransaction) => {
    const verificationToken = await this.repository.consumeVerifiedEmailToken(
      token,
      this.normalizeEmail(email),
      transaction,
    );
    if (!verificationToken) throw new CustomUnauthorizedException(EmailErrorMessage.InvalidCode);
    return true;
  };
  normalizeEmail = (email: string) => {
    const normalized = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) || normalized.length > 255)
      throw new CustomBadRequestException(EmailErrorMessage.InvalidEmail);
    return normalized;
  };
  normalizeUserid = (userid: string) => {
    const normalized = userid.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(normalized))
      throw new CustomBadRequestException("아이디는 3~40자의 영문, 숫자, ., _, -만 사용할 수 있습니다.");
    return normalized;
  };
  assertPassword = (password: string) => {
    if (password.length < 8 || Buffer.byteLength(password, "utf8") > 72)
      throw new CustomBadRequestException(EmailErrorMessage.InvalidPassword);
  };
  queueAdminInvite = (transaction: DatabaseTransaction, email: string, token: string, inviteId: string) =>
    this.repository.enqueueDelivery(
      {
        email,
        expiresAt: new Date(Date.now() + 23 * 60 * 60_000),
        kind: EmailDeliveryKind.AdminInvite,
        payloadCiphertext: encryptEmailPayload(token, this.configService.getOrThrow<string>("EMAIL_CODE_PEPPER")),
        proofId: inviteId,
      },
      transaction,
    );
  private pepperedCode = (email: string, code: string, purpose: EmailVerificationPurposeValue) =>
    emailCodeSecret(email, code, purpose, this.configService.getOrThrow<string>("EMAIL_CODE_PEPPER"));
  private queueDelivery = (email: string, ip: string, kind: EmailDeliveryKindValue, lifetimeMs: number) =>
    this.repository.enqueueDelivery({
      email,
      expiresAt: new Date(Date.now() + lifetimeMs),
      kind,
      requestIpHash: this.sha256(ip),
    });
  private admitEmailDelivery = (email: string, origin: RequestOrigin) =>
    this.admissionLimiter.assertAllowed(
      "EMAIL_DELIVERY",
      [
        { scopeType: "email-cooldown", value: email, limit: 1, windowMs: 60_000 },
        ...this.admissionRules(email, origin, 5, 60 * 60_000, "delivery"),
      ],
      (scopeType) =>
        scopeType === "email-cooldown" ? EmailErrorMessage.CodeRetryTooSoon : EmailErrorMessage.RequestLimitExceeded,
    );
  private admissionRules = (
    email: string,
    origin: RequestOrigin,
    emailLimit: number,
    windowMs: number,
    prefix: string,
  ): AdmissionRule[] => [
    { scopeType: `${prefix}-email`, value: email, limit: emailLimit, windowMs },
    ...this.requesterRules(origin, 20, windowMs, prefix),
  ];
  private requesterRules = (
    origin: RequestOrigin,
    limit: number,
    windowMs: number,
    prefix: string,
  ): AdmissionRule[] => [
    { scopeType: `${prefix}-ip`, value: origin.ip, limit, windowMs },
    ...(origin.deviceId
      ? [{ scopeType: `${prefix}-device`, value: origin.deviceId, limit, windowMs } satisfies AdmissionRule]
      : []),
  ];
  private sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
  private proofToken = (verificationId: string) =>
    createHmac("sha256", this.configService.getOrThrow<string>("EMAIL_CODE_PEPPER"))
      .update("email-verification-proof\0")
      .update(verificationId)
      .digest("base64url");
}
