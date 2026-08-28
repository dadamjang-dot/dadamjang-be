import { ConfigService } from "@nestjs/config";
import type { Response } from "express";
import { hashToken } from "src/common/security/token-hash";
import { KakaoFlowService } from "src/modules/fo-auth/kakao-flow.service";
import { AuthController } from "./auth.controller";
import type { KakaoRequest } from "./auth.types";

describe("AuthController", () => {
  it("redirects the Kakao callback token and never its hash", async () => {
    const callbackToken = "kakao-callback-token";
    const service = {
      acceptCallback: jest.fn().mockResolvedValue({ callbackToken }),
    } as unknown as KakaoFlowService;
    const config = {
      get: jest.fn().mockReturnValue("dadamjang://auth/kakao-callback"),
    } as unknown as ConfigService;
    const redirect = jest.fn();
    const response = { clearCookie: jest.fn(), redirect } as unknown as Response;
    const request = {
      cookies: { kakao_oauth_flow: "flow-id" },
      user: { providerUserId: "kakao-user", emailVerified: true },
    } as unknown as KakaoRequest;
    const controller = new AuthController(service, config);

    await controller.kakaoCallback(request, response);

    const target = String(redirect.mock.calls[0]?.[0]);
    expect(new URL(target).searchParams.get("callbackToken")).toBe(callbackToken);
    expect(target).not.toContain(hashToken(callbackToken));
  });
});
