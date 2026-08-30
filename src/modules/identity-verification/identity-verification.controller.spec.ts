import { ConfigService } from "@nestjs/config";
import type { Response } from "express";
import { hashToken } from "src/common/security/token-hash";
import { IdentityVerificationController } from "./identity-verification.controller";
import { IdentityVerificationService } from "./identity-verification.service";

describe("IdentityVerificationController", () => {
  it("redirects the identity callback token and never its hash", async () => {
    const callbackToken = "identity-callback-token";
    const service = {
      callback: jest.fn().mockResolvedValue({ callbackToken }),
    } as unknown as IdentityVerificationService;
    const config = {
      get: jest.fn().mockReturnValue("dadamjang://auth/identity-callback"),
    } as unknown as ConfigService;
    const redirect = jest.fn();
    const response = { redirect } as unknown as Response;
    const controller = new IdentityVerificationController(service, config);

    await controller.success("session-id", { resultCode: "0000" }, response);

    const target = String(redirect.mock.calls[0]?.[0]);
    expect(new URL(target).searchParams.get("callbackToken")).toBe(callbackToken);
    expect(target).not.toContain(hashToken(callbackToken));
  });
});
