import { ConfigService } from "@nestjs/config";
import { hashToken } from "src/common/security/token-hash";
import { UserRole } from "src/auth/role";
import { AuthService } from "src/modules/auth/auth.service";
import { EmailService } from "src/modules/email/email.service";
import { InvalidFoAuthProofError } from "./fo-auth.error";
import { FoAuthService } from "./fo-auth.service";
import { KakaoFlowRepository } from "./kakao-flow.repository";
import { KakaoFlowService } from "./kakao-flow.service";

const user = {
  userId: "10000000-0000-4000-8000-000000000001",
  userid: "user",
  email: "user@example.test",
  password: "hash",
  role: UserRole.User,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const callbackToken = "token-seen-only-by-device-b";

const createService = () => {
  let consumed = false;
  const repository = {
    acceptCallback: jest.fn().mockImplementation(async (_flowId, _profile, _email, callbackTokenHash) => ({
      flowId: "flow-id",
      callbackTokenHash,
    })),
    completeLoginFlow: jest.fn(
      async (
        _flowId: string,
        deviceIdHash: string,
        presentedCallbackToken: string,
        _signupToken: string,
        issueTokens: (value: typeof user, store: object) => Promise<object>,
      ) => {
        if (deviceIdHash !== hashToken("device-b") || presentedCallbackToken !== callbackToken || consumed)
          throw new InvalidFoAuthProofError();
        consumed = true;
        return { kind: "existing" as const, tokenPayload: await issueTokens(user, {}) };
      },
    ),
  } as unknown as KakaoFlowRepository;
  const authService = {
    issueTokensForUser: jest.fn().mockResolvedValue({
      accessToken: "access",
      refreshToken: "refresh",
      role: UserRole.User,
    }),
  } as unknown as AuthService;
  return {
    repository,
    service: new KakaoFlowService(
      repository,
      authService,
      {} as FoAuthService,
      { normalizeEmail: (email: string) => email } as EmailService,
      {} as ConfigService,
    ),
  };
};

describe("KakaoFlowService", () => {
  it("persists only a callback-token hash and returns the plaintext once", async () => {
    const { repository, service } = createService();

    const result = (await service.acceptCallback("flow-id", {
      providerUserId: "kakao-user",
      email: "user@example.test",
      emailVerified: true,
    })) as unknown as { callbackToken: string };

    expect(result).toEqual({ callbackToken: expect.any(String) });
    expect(repository.acceptCallback).toHaveBeenCalledWith(
      "flow-id",
      expect.objectContaining({ providerUserId: "kakao-user" }),
      "user@example.test",
      hashToken(result.callbackToken),
    );
  });

  it("binds callback-token redemption to the device and consumes it once", async () => {
    const { service } = createService();
    const completeLogin = service.completeLogin as unknown as (
      flowId: string,
      deviceId: string,
      token: string,
    ) => Promise<object>;

    await expect(completeLogin("flow-id", "device-a", "token-seen-only-by-device-b")).rejects.toThrow();
    await expect(completeLogin("flow-id", "device-b", callbackToken)).resolves.toMatchObject({
      status: "SIGNED_IN",
    });
    await expect(completeLogin("flow-id", "device-b", callbackToken)).rejects.toThrow();
  });
});
