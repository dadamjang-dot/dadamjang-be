import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as bcrypt from "bcrypt";
import { randomBytes, randomUUID } from "crypto";
import { CustomBadRequestException, CustomUnauthorizedException } from "src/common/errors/custom-exceptions";
import { hasDatabaseErrorCode } from "src/common/errors/database-error";
import { hashToken } from "src/common/security/token-hash";
import { UserRole } from "src/auth/role";
import { AdmissionLimiter, type RequestOrigin } from "src/modules/admission/admission-limiter";
import type { KakaoProfile } from "src/modules/auth/auth.types";
import { AuthService } from "src/modules/auth/auth.service";
import { EmailService } from "src/modules/email/email.service";
import { InvalidFoAuthProofError } from "./fo-auth.error";
import { FoAuthService } from "./fo-auth.service";
import type { CompleteKakaoSignupFoInput } from "./fo-auth.types";
import { KakaoFlowRepository } from "./kakao-flow.repository";

@Injectable()
export class KakaoFlowService {
  constructor(
    private readonly repository: KakaoFlowRepository,
    private readonly authService: AuthService,
    private readonly foAuthService: FoAuthService,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
    private readonly admissionLimiter: AdmissionLimiter,
  ) {}

  start = async (deviceId: string, origin: RequestOrigin) => {
    await this.admissionLimiter.assertAllowed(
      "KAKAO_LOGIN_START",
      [
        { scopeType: "start-ip", value: origin.ip, limit: 20, windowMs: 15 * 60_000 },
        { scopeType: "start-device", value: deviceId, limit: 20, windowMs: 15 * 60_000 },
      ],
      "카카오 로그인 요청 횟수를 초과했습니다.",
    );
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const flow = await this.repository.createFlow(hashToken(deviceId), expiresAt);
    if (!flow) throw new CustomBadRequestException("카카오 로그인 흐름을 만들지 못했습니다.");
    const apiBaseUrl =
      this.configService.get<string>("API_PUBLIC_BASE_URL") ??
      `http://localhost:${this.configService.get<string>("PORT") ?? "5500"}`;
    return {
      flowId: flow.flowId,
      authUrl: `${apiBaseUrl}/api/auth/kakao?flowId=${encodeURIComponent(flow.flowId)}`,
      expiresAt: flow.expiresAt,
    };
  };

  acceptCallback = async (flowId: string, profile: KakaoProfile) => {
    const email = profile.email ? this.emailService.normalizeEmail(profile.email) : undefined;
    const callbackToken = randomBytes(32).toString("base64url");
    const flow = await this.repository.acceptCallback(flowId, profile, email, hashToken(callbackToken));
    if (!flow) throw new CustomUnauthorizedException("카카오 로그인 흐름이 유효하지 않습니다.");
    return { callbackToken };
  };

  completeLogin = async (flowId: string, deviceId: string, callbackToken: string) => {
    const signupToken = randomBytes(32).toString("base64url");
    try {
      const result = await this.repository.completeLoginFlow(
        flowId,
        hashToken(deviceId),
        callbackToken,
        signupToken,
        async (user, store) => {
          if (user.role !== UserRole.User) throw new InvalidFoAuthProofError();
          return this.authService.issueTokensForUser(user, deviceId, store);
        },
      );
      if (result.kind === "existing") {
        return {
          status: "SIGNED_IN" as const,
          tokenPayload: result.tokenPayload,
          emailVerificationRequired: false,
        };
      }
      return {
        status: "SIGNUP_REQUIRED" as const,
        kakaoSignupToken: signupToken,
        email: result.email,
        emailVerificationRequired: !result.emailVerified,
      };
    } catch (error) {
      if (error instanceof InvalidFoAuthProofError)
        throw new CustomUnauthorizedException("카카오 로그인 흐름이 유효하지 않습니다.");
      throw error;
    }
  };

  completeSignup = async (input: CompleteKakaoSignupFoInput, deviceId: string) => {
    await this.foAuthService.assertSignupConsents(input.consents);
    const email = input.email ? this.emailService.normalizeEmail(input.email) : undefined;
    try {
      return await this.repository.completeSignup(
        {
          kakaoSignupToken: input.kakaoSignupToken,
          ...(email === undefined ? {} : { email }),
          ...(input.emailVerificationToken === undefined
            ? {}
            : { emailVerificationToken: input.emailVerificationToken }),
          identityVerificationToken: input.identityVerificationToken,
          deviceIdHash: hashToken(deviceId),
          userId: randomUUID(),
          userid: `member-${randomBytes(6).toString("hex")}`,
          password: await bcrypt.hash(randomBytes(32).toString("base64url"), 10),
          consents: input.consents,
        },
        async (user, store) => {
          if (user.role !== UserRole.User) throw new InvalidFoAuthProofError();
          return this.authService.issueTokensForUser(user, deviceId, store);
        },
      );
    } catch (error) {
      if (error instanceof InvalidFoAuthProofError)
        throw new CustomUnauthorizedException("카카오 가입 인증이 유효하지 않습니다.");
      if (hasDatabaseErrorCode(error, "23505")) throw new CustomBadRequestException("이미 가입된 이메일입니다.");
      throw error;
    }
  };
}
