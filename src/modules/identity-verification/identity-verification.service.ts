import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHmac, randomBytes } from "crypto";
import { CustomBadRequestException, CustomUnauthorizedException } from "src/common/errors/custom-exceptions";
import { hashToken } from "src/common/security/token-hash";
import { InicisIdentityAdapter } from "./inicis-identity.adapter";
import { IdentityVerificationRepository } from "./identity-verification.repository";
import {
  IdentityVerificationProvider,
  IdentityVerificationStatus,
  type IdentityVerificationProviderValue,
  type InicisCallbackInput,
  type StartIdentityVerificationInput,
} from "./identity-verification.types";

@Injectable()
export class IdentityVerificationService {
  constructor(
    private readonly repository: IdentityVerificationRepository,
    private readonly adapter: InicisIdentityAdapter,
    private readonly configService: ConfigService,
  ) {}

  start = async (input: StartIdentityVerificationInput, deviceId: string) => {
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const session = await this.repository.createSession({
      purpose: input.purpose,
      provider: input.provider,
      deviceIdHash: hashToken(deviceId),
      merchantTransactionId: randomBytes(10).toString("hex"),
      expiresAt,
    });
    if (!session) throw new CustomBadRequestException("본인인증 세션을 만들지 못했습니다.");
    const apiBaseUrl =
      this.configService.get<string>("IDENTITY_INICIS_CALLBACK_BASE_URL") ??
      `http://localhost:${this.configService.get<string>("PORT") ?? "5500"}`;
    return {
      sessionId: session.sessionId,
      launchUrl: `${apiBaseUrl}/api/auth/identity/inicis/start/${session.sessionId}`,
      expiresAt,
    };
  };

  status = async (sessionId: string, deviceId: string) => {
    const session = await this.requireDeviceSession(sessionId, deviceId);
    const status =
      session.expiresAt.getTime() <= Date.now() && session.status === "PENDING"
        ? IdentityVerificationStatus.EXPIRED
        : session.status;
    return { sessionId, status, expiresAt: session.expiresAt };
  };

  complete = async (sessionId: string, deviceId: string, callbackToken: string) => {
    const token = randomBytes(32).toString("base64url");
    const completed = await this.repository.completeSession(sessionId, hashToken(deviceId), callbackToken, token);
    if (!completed) throw new CustomUnauthorizedException("본인인증 완료 상태가 유효하지 않습니다.");
    return { identityVerificationToken: token };
  };

  requestPage = async (sessionId: string) => {
    const session = await this.repository.findSession(sessionId);
    if (!session || session.status !== "PENDING" || session.expiresAt.getTime() <= Date.now())
      throw new CustomUnauthorizedException("본인인증 세션이 유효하지 않습니다.");
    if (this.isMockEnabled()) {
      const callbackToken = randomBytes(32).toString("base64url");
      await this.repository.markVerified({
        sessionId,
        ciHash: this.hashCi(`local-ci-${session.deviceIdHash}`),
        certificateProvider: session.provider,
        isFourteenOrOlder: true,
        callbackTokenHash: hashToken(callbackToken),
      });
      return { kind: "mock" as const, callbackToken };
    }
    return {
      kind: "inicis" as const,
      request: this.adapter.createRequest({
        sessionId,
        merchantTransactionId: session.merchantTransactionId,
        provider: this.parseProvider(session.provider),
      }),
    };
  };

  callback = async (sessionId: string, input: InicisCallbackInput) => {
    const session = await this.repository.findSession(sessionId);
    if (!session) throw new CustomUnauthorizedException("본인인증 세션이 유효하지 않습니다.");
    if (session.status !== "PENDING" || session.expiresAt.getTime() <= Date.now())
      throw new CustomUnauthorizedException("본인인증 세션이 유효하지 않습니다.");
    try {
      const result = await this.adapter.verify(
        {
          sessionId,
          merchantTransactionId: session.merchantTransactionId,
          provider: this.parseProvider(session.provider),
        },
        input,
      );
      const callbackToken = randomBytes(32).toString("base64url");
      const verified = await this.repository.markVerified({
        sessionId,
        ciHash: this.hashCi(result.ci),
        certificateProvider: result.certificateProvider,
        isFourteenOrOlder: this.isFourteenOrOlder(result.birthday),
        callbackTokenHash: hashToken(callbackToken),
      });
      if (!verified) throw new CustomUnauthorizedException("본인인증 결과를 저장하지 못했습니다.");
      return { callbackToken };
    } catch (error) {
      await this.repository.markFailed(sessionId, input.resultCode || "INVALID_RESULT");
      throw error;
    }
  };

  fail = async (sessionId: string, failureCode: string) => {
    await this.repository.markFailed(sessionId, failureCode || "CANCELED");
  };

  private requireDeviceSession = async (sessionId: string, deviceId: string) => {
    const session = await this.repository.findSession(sessionId);
    if (!session || session.deviceIdHash !== hashToken(deviceId))
      throw new CustomUnauthorizedException("본인인증 세션이 유효하지 않습니다.");
    return session;
  };

  private hashCi = (ci: string) =>
    createHmac("sha256", this.configService.getOrThrow<string>("IDENTITY_CI_PEPPER")).update(ci).digest("hex");

  private isFourteenOrOlder = (birthday: string) => {
    if (!/^\d{8}$/u.test(birthday)) return false;
    const year = Number(birthday.slice(0, 4));
    const month = Number(birthday.slice(4, 6));
    const day = Number(birthday.slice(6, 8));
    const birthDate = new Date(Date.UTC(year, month - 1, day));
    if (birthDate.getUTCFullYear() !== year || birthDate.getUTCMonth() !== month - 1 || birthDate.getUTCDate() !== day)
      return false;
    const today = new Date();
    return birthDate.getTime() <= Date.UTC(today.getUTCFullYear() - 14, today.getUTCMonth(), today.getUTCDate());
  };

  private isMockEnabled = () =>
    this.configService.get<string>("IDENTITY_VERIFICATION_MOCK_ENABLED") === "true" &&
    this.configService.get<string>("NODE_ENV") !== "production";

  private parseProvider = (value: string): IdentityVerificationProviderValue => {
    switch (value) {
      case IdentityVerificationProvider.TOSS:
        return IdentityVerificationProvider.TOSS;
      case IdentityVerificationProvider.KAKAO:
        return IdentityVerificationProvider.KAKAO;
      case IdentityVerificationProvider.NAVER:
        return IdentityVerificationProvider.NAVER;
      default:
        throw new CustomBadRequestException("지원하지 않는 본인인증 제공자입니다.");
    }
  };
}
