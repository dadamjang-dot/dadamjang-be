import * as bcrypt from "bcrypt";
import { ConfigService } from "@nestjs/config";
import { EmailRepository } from "./email.repository";
import { EmailSender } from "./email.sender";
import { EmailService } from "./email.service";

describe("EmailService", () => {
  const config = { getOrThrow: jest.fn().mockReturnValue("pepper") } as unknown as ConfigService;

  it("issues a signup token only after a valid email code", async () => {
    const codeHash = await bcrypt.hash("user@example.com:123456:pepper", 10);
    const repository = {
      latestVerification: jest.fn().mockResolvedValue({
        id: "verification",
        codeHash,
        expiresAt: new Date(Date.now() + 60_000),
        verifiedAt: null,
        attemptCount: 0,
      }),
      markVerified: jest.fn().mockResolvedValue({ id: "verification" }),
      createSignupToken: jest.fn().mockResolvedValue(undefined),
    } as unknown as EmailRepository;
    const service = new EmailService(repository, config, {} as EmailSender);

    await expect(service.verifySignupCode("USER@example.com", "123456")).resolves.toEqual({
      emailVerificationToken: expect.any(String),
    });
    expect(repository.createSignupToken).toHaveBeenCalledWith(
      expect.any(String),
      "user@example.com",
      "verification",
      expect.any(Date),
    );
  });

  it("resets password only with a one-time reset token", async () => {
    const repository = {
      consumePasswordResetToken: jest.fn().mockResolvedValue({ userId: "user" }),
      resetPassword: jest.fn().mockResolvedValue(undefined),
    } as unknown as EmailRepository;
    const service = new EmailService(repository, config, {} as EmailSender);

    await expect(service.resetPassword("token", "new-password")).resolves.toEqual({ ok: true });
    expect(repository.resetPassword).toHaveBeenCalledWith("user", expect.any(String));
  });
});
