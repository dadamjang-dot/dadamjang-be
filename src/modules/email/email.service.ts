import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as bcrypt from "bcrypt";
import { createHash, randomBytes, randomInt } from "crypto";
import { CustomBadRequestException, CustomServiceUnavailableException, CustomTooManyRequestsException, CustomUnauthorizedException } from "src/common/errors/custom-exceptions";
import { EmailSender } from "./email.sender";
import { EmailErrorMessage } from "./email.error";
import { EmailRepository } from "./email.repository";

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  constructor(private readonly repository: EmailRepository, private readonly configService: ConfigService, @Inject("EmailSender") private readonly sender: EmailSender) {}
  requestSignupCode = async (email: string, ip?: string) => {
    const normalizedEmail = this.normalizeEmail(email);
    const now = new Date();
    const latest = await this.repository.latestVerification(normalizedEmail);
    if (latest && now.getTime() - latest.createdAt.getTime() < 60_000) throw new CustomTooManyRequestsException(EmailErrorMessage.CodeRetryTooSoon);
    const since = new Date(now.getTime() - 60 * 60 * 1000);
    const ipHash = this.sha256(ip ?? "unknown");
    const [byEmail, byIp] = await Promise.all([this.repository.verificationsSince(normalizedEmail, since), this.repository.ipVerificationsSince(ipHash, since)]);
    if (byEmail.length >= 5 || byIp.length >= 20) throw new CustomTooManyRequestsException(EmailErrorMessage.RequestLimitExceeded);
    const code = String(randomInt(1_000_000)).padStart(6, "0");
    const verification = await this.repository.createVerification({ email: normalizedEmail, codeHash: await bcrypt.hash(this.pepperedCode(normalizedEmail, code), 10), expiresAt: new Date(now.getTime() + 5 * 60 * 1000), requestIpHash: ipHash });
    try { await this.sender.sendCode(normalizedEmail, code); } catch { await this.repository.deleteVerification(verification.id); throw new CustomServiceUnavailableException(EmailErrorMessage.EmailSendFailed); }
    return { ok: true };
  };
  verifySignupCode = async (email: string, code: string) => {
    const normalizedEmail = this.normalizeEmail(email);
    const verification = await this.repository.latestVerification(normalizedEmail);
    if (!verification || verification.verifiedAt) throw new CustomUnauthorizedException(EmailErrorMessage.InvalidCode);
    if (verification.expiresAt.getTime() <= Date.now()) throw new CustomUnauthorizedException(EmailErrorMessage.ExpiredCode);
    if (verification.attemptCount >= 5) throw new CustomTooManyRequestsException(EmailErrorMessage.CodeAttemptLimitExceeded);
    if (!(await bcrypt.compare(this.pepperedCode(normalizedEmail, code), verification.codeHash))) { await this.repository.incrementAttempt(verification.id); throw new CustomUnauthorizedException(EmailErrorMessage.InvalidCode); }
    const verified = await this.repository.markVerified(verification.id);
    if (!verified) throw new CustomUnauthorizedException(EmailErrorMessage.InvalidCode);
    const token = this.createOpaqueToken();
    await this.repository.createSignupToken(token, normalizedEmail, verified.id, new Date(Date.now() + 15 * 60 * 1000));
    return { emailVerificationToken: token };
  };
  requestPasswordReset = async (email: string, ip?: string) => {
    const user = await this.repository.findUserByEmail(this.normalizeEmail(email));
    if (user) await this.requestPasswordResetForUser(user, ip);
    return { ok: true };
  };
  resetPassword = async (token: string, password: string) => {
    if (password.length < 8) throw new CustomBadRequestException(EmailErrorMessage.InvalidPassword);
    const recovery = await this.repository.consumePasswordResetToken(token);
    if (!recovery) throw new CustomUnauthorizedException(EmailErrorMessage.InvalidRecoveryToken);
    await this.repository.resetPassword(recovery.userId, await bcrypt.hash(password, 10));
    return { ok: true };
  };
  consumeSignupToken = async (token: string, email: string, input: { userId: string; userid: string; password: string }) => this.repository.consumeSignupTokenAndCreateUser(token, { ...input, email: this.normalizeEmail(email), userid: this.normalizeUserid(input.userid) });
  normalizeEmail = (email: string) => { const normalized = email.trim().toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) || normalized.length > 255) throw new CustomBadRequestException(EmailErrorMessage.InvalidEmail); return normalized; };
  normalizeUserid = (userid: string) => { const normalized = userid.trim().toLowerCase(); if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(normalized)) throw new CustomBadRequestException("아이디는 3~40자의 영문, 숫자, ., _, -만 사용할 수 있습니다."); return normalized; };
  private requestPasswordResetForUser = async (user: { userId: string; email: string }, ip?: string) => { const token = this.createOpaqueToken(); await this.repository.createPasswordResetToken(token, user.userId, new Date(Date.now() + 15 * 60 * 1000), this.sha256(ip ?? "unknown")); await this.sender.sendLink(user.email, "비밀번호 재설정", `/account-recovery/password#token=${token}`); };
  private pepperedCode = (email: string, code: string) => `${email}:${code}:${this.configService.getOrThrow<string>("EMAIL_CODE_PEPPER")}`;
  private sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
  private createOpaqueToken = () => randomBytes(32).toString("base64url");
}
