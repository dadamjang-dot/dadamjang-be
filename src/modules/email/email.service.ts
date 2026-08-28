import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as bcrypt from "bcrypt";
import { createHash, randomBytes, randomInt } from "crypto";
import {
  CustomBadRequestException,
  CustomServiceUnavailableException,
  CustomTooManyRequestsException,
  CustomUnauthorizedException,
} from "src/common/errors/custom-exceptions";
import { EmailSender } from "./email.sender";
import { EmailErrorMessage } from "./email.error";
import { EmailRepository } from "./email.repository";
import { EmailVerificationPurpose, type EmailVerificationPurposeValue } from "./email.types";

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  constructor(
    private readonly repository: EmailRepository,
    private readonly configService: ConfigService,
    @Inject("EmailSender") private readonly sender: EmailSender,
  ) {}
  requestSignupCode = (email: string, ip?: string) => this.requestCode(email, EmailVerificationPurpose.Signup, ip);
  requestPasswordResetCode = (email: string, ip?: string) => this.requestRecoveryCode(email, ip);
  verifySignupCode = (email: string, code: string) => this.verifyCode(email, code, EmailVerificationPurpose.Signup);
  verifyPasswordResetCode = (email: string, code: string) =>
    this.verifyCode(email, code, EmailVerificationPurpose.PasswordReset);
  private requestRecoveryCode = async (email: string, ip?: string) => {
    const normalizedEmail = this.normalizeEmail(email);
    const user = await this.repository.findUserByEmail(normalizedEmail);
    if (user) return this.requestCode(normalizedEmail, EmailVerificationPurpose.PasswordReset, ip);
    await bcrypt.hash(this.pepperedCode(normalizedEmail, "000000", EmailVerificationPurpose.PasswordReset), 10);
    return { ok: true };
  };
  private requestCode = async (email: string, purpose: EmailVerificationPurposeValue, ip?: string) => {
    const normalizedEmail = this.normalizeEmail(email);
    const now = new Date();
    const latest = await this.repository.latestVerification(normalizedEmail, purpose);
    if (latest && now.getTime() - latest.createdAt.getTime() < 60_000)
      throw new CustomTooManyRequestsException(EmailErrorMessage.CodeRetryTooSoon);
    const since = new Date(now.getTime() - 60 * 60 * 1000);
    const ipHash = this.sha256(ip ?? "unknown");
    const [byEmail, byIp] = await Promise.all([
      this.repository.verificationsSince(normalizedEmail, since),
      this.repository.ipVerificationsSince(ipHash, since),
    ]);
    if (byEmail.length >= 5 || byIp.length >= 20)
      throw new CustomTooManyRequestsException(EmailErrorMessage.RequestLimitExceeded);
    const code = String(randomInt(1_000_000)).padStart(6, "0");
    const verification = await this.repository.createVerification({
      email: normalizedEmail,
      purpose,
      codeHash: await bcrypt.hash(this.pepperedCode(normalizedEmail, code, purpose), 10),
      expiresAt: new Date(now.getTime() + 5 * 60 * 1000),
      requestIpHash: ipHash,
    });
    try {
      await this.sender.sendCode(normalizedEmail, code);
    } catch {
      await this.repository.deleteVerification(verification.id);
      throw new CustomServiceUnavailableException(EmailErrorMessage.EmailSendFailed);
    }
    return { ok: true };
  };
  private verifyCode = async (email: string, code: string, purpose: EmailVerificationPurposeValue) => {
    const normalizedEmail = this.normalizeEmail(email);
    const verification = await this.repository.latestVerification(normalizedEmail, purpose);
    if (!verification || verification.verifiedAt) throw new CustomUnauthorizedException(EmailErrorMessage.InvalidCode);
    if (verification.expiresAt.getTime() <= Date.now())
      throw new CustomUnauthorizedException(EmailErrorMessage.ExpiredCode);
    if (verification.attemptCount >= 5)
      throw new CustomTooManyRequestsException(EmailErrorMessage.CodeAttemptLimitExceeded);
    if (!(await bcrypt.compare(this.pepperedCode(normalizedEmail, code, purpose), verification.codeHash))) {
      await this.repository.incrementAttempt(verification.id);
      throw new CustomUnauthorizedException(EmailErrorMessage.InvalidCode);
    }
    const verified = await this.repository.markVerified(verification.id);
    if (!verified) throw new CustomUnauthorizedException(EmailErrorMessage.InvalidCode);
    const token = this.createOpaqueToken();
    await this.repository.createVerificationToken(
      token,
      normalizedEmail,
      purpose,
      verified.id,
      new Date(Date.now() + 15 * 60 * 1000),
    );
    return { emailVerificationToken: token };
  };
  requestPasswordReset = async (email: string, ip?: string) => {
    const user = await this.repository.findUserByEmail(this.normalizeEmail(email));
    if (user) await this.requestPasswordResetForUser(user, ip);
    return { ok: true };
  };
  resetPassword = async (token: string, password: string) => {
    this.assertPassword(password);
    const reset = await this.repository.resetPasswordWithToken(token, await bcrypt.hash(password, 10));
    if (!reset) throw new CustomUnauthorizedException(EmailErrorMessage.InvalidRecoveryToken);
    return { ok: true };
  };
  consumeVerifiedEmailToken = async (token: string, email: string) => {
    const verificationToken = await this.repository.consumeVerifiedEmailToken(token, this.normalizeEmail(email));
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
  sendAdminInvite = (email: string, token: string) => {
    const boUrl = this.configService.getOrThrow<string>("DADAMJANG_BO_URL").replace(/\/$/, "");
    return this.sender.sendLink(email, "다담장 관리자 초대", `${boUrl}/invite/accept#token=${token}`);
  };
  private requestPasswordResetForUser = async (user: { userId: string; email: string }, ip?: string) => {
    const token = this.createOpaqueToken();
    await this.repository.createPasswordResetToken(
      token,
      user.userId,
      new Date(Date.now() + 15 * 60 * 1000),
      this.sha256(ip ?? "unknown"),
    );
    const clientUrl = this.configService.getOrThrow<string>("CLIENT_URL").replace(/\/$/, "");
    await this.sender.sendLink(user.email, "비밀번호 재설정", `${clientUrl}/account-recovery/password#token=${token}`);
  };
  private pepperedCode = (email: string, code: string, purpose: EmailVerificationPurposeValue) =>
    `${email}:${code}:${purpose}:${this.configService.getOrThrow<string>("EMAIL_CODE_PEPPER")}`;
  private sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
  private createOpaqueToken = () => randomBytes(32).toString("base64url");
}
