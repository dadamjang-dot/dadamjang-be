import { Injectable } from "@nestjs/common";
import * as bcrypt from "bcrypt";
import { randomBytes, randomUUID } from "crypto";
import { CustomBadRequestException, CustomUnauthorizedException } from "src/common/errors/custom-exceptions";
import { hasDatabaseErrorCode } from "src/common/errors/database-error";
import { hashToken } from "src/common/security/token-hash";
import { AdmissionLimiter, type RequestOrigin } from "src/modules/admission/admission-limiter";
import { UserRole } from "src/auth/role";
import { AuthService } from "src/modules/auth/auth.service";
import { EmailService } from "src/modules/email/email.service";
import { ExistingFoIdentityError, InvalidFoAuthProofError } from "./fo-auth.error";
import { FoAuthRepository } from "./fo-auth.repository";
import type { ConsentAcceptanceInput, SigninFoInput, SignupFoInput } from "./fo-auth.types";

const invalidPasswordHash = "$2b$10$nmo8L8VvFVH2sB.e3T0hP.TQMDhHxk88WTtFBkDgnjAlnHDR4W/rW";
const signupConsentTypes = ["AGE_OVER_14", "SERVICE_TERMS", "PRIVACY_COLLECTION", "MARKETING"];

@Injectable()
export class FoAuthService {
  constructor(
    private readonly repository: FoAuthRepository,
    private readonly authService: AuthService,
    private readonly emailService: EmailService,
    private readonly admissionLimiter: AdmissionLimiter,
  ) {}

  signin = async (input: SigninFoInput, deviceId: string, origin: RequestOrigin) => {
    const email = this.emailService.normalizeEmail(input.email);
    await this.admissionLimiter.assertAllowed(
      "AUTH_SIGNIN_FO",
      [
        { scopeType: "signin-ip", value: origin.ip, limit: 20, windowMs: 15 * 60_000 },
        { scopeType: "signin-account", value: email, limit: 20, windowMs: 15 * 60_000 },
        { scopeType: "signin-device", value: origin.deviceId ?? deviceId, limit: 20, windowMs: 15 * 60_000 },
      ],
      "이메일 또는 비밀번호가 올바르지 않습니다.",
    );
    const signinStartedAt = await this.authService.signinStartedAt();
    const user = await this.repository.findByEmail(email);
    if (!user) {
      await bcrypt.compare(input.password, invalidPasswordHash);
      throw new CustomUnauthorizedException("이메일 또는 비밀번호가 올바르지 않습니다.");
    }
    return this.authService.withSigninLock(user.userId, deviceId, async (store) => {
      const validPassword = await bcrypt.compare(input.password, user.password);
      if (!validPassword || user.role !== UserRole.User)
        throw new CustomUnauthorizedException("이메일 또는 비밀번호가 올바르지 않습니다.");
      return this.authService.issueTokensForUser(user, deviceId, store, signinStartedAt);
    });
  };

  signup = async (input: SignupFoInput, deviceId: string) => {
    this.emailService.assertPassword(input.password);
    const email = this.emailService.normalizeEmail(input.email);
    await this.assertSignupConsents(input.consents);
    try {
      return await this.repository.createEmailUser(
        {
          userId: randomUUID(),
          userid: `member-${randomBytes(6).toString("hex")}`,
          email,
          password: await bcrypt.hash(input.password, 10),
          emailVerificationToken: input.emailVerificationToken,
          identityVerificationToken: input.identityVerificationToken,
          deviceIdHash: hashToken(deviceId),
          consents: input.consents,
        },
        (user, store) => this.authService.issueTokensForUser(user, deviceId, store),
      );
    } catch (error) {
      if (error instanceof ExistingFoIdentityError)
        throw new CustomBadRequestException("이미 가입된 본인정보입니다. 이메일 찾기를 이용해주세요.");
      if (error instanceof InvalidFoAuthProofError)
        throw new CustomUnauthorizedException("가입 인증이 유효하지 않습니다.");
      if (hasDatabaseErrorCode(error, "23505")) throw new CustomBadRequestException("이미 가입된 이메일입니다.");
      throw error;
    }
  };

  activeConsentDocuments = () => this.currentConsentDocuments();

  findEmail = async (identityVerificationToken: string, deviceId: string) => {
    try {
      const result = await this.repository.consumeFindEmailProof(identityVerificationToken, hashToken(deviceId));
      return result ? { found: true, maskedEmail: this.maskEmail(result.email) } : { found: false };
    } catch (error) {
      if (error instanceof InvalidFoAuthProofError)
        throw new CustomUnauthorizedException("본인인증이 유효하지 않습니다.");
      throw error;
    }
  };

  updateMarketingConsent = (userId: string, agreed: boolean) => this.repository.updateMarketingConsent(userId, agreed);

  assertSignupConsents = async (consents: readonly ConsentAcceptanceInput[]) => {
    const documents = await this.currentConsentDocuments();
    const hasConfiguredDocuments = signupConsentTypes.every((type) =>
      documents.some((document) => document.type === type),
    );
    const acceptanceById = new Map(consents.map((consent) => [consent.documentId, consent.agreed]));
    const hasExactDocuments =
      documents.length === consents.length && documents.every((document) => acceptanceById.has(document.documentId));
    const hasRequiredConsents = documents.every(
      (document) => !document.required || acceptanceById.get(document.documentId) === true,
    );
    if (!hasConfiguredDocuments || !hasExactDocuments || !hasRequiredConsents)
      throw new CustomBadRequestException("필수 약관 동의가 필요합니다.");
  };

  private maskEmail = (email: string) => {
    const [local, domain] = email.split("@");
    if (!local || !domain) return "***";
    return `${local.slice(0, Math.min(2, local.length))}***@${domain}`;
  };

  private currentConsentDocuments = async () => {
    const documents = await this.repository.activeConsentDocuments(new Date());
    const latestByType = new Map<string, (typeof documents)[number]>();
    for (const document of documents) {
      if (!latestByType.has(document.type)) latestByType.set(document.type, document);
    }
    return [...latestByType.values()].sort(
      (left, right) => signupConsentTypes.indexOf(left.type) - signupConsentTypes.indexOf(right.type),
    );
  };
}
