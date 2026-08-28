import * as bcrypt from "bcrypt";
import { ConfigService } from "@nestjs/config";
import { CustomTooManyRequestsException, CustomUnauthorizedException } from "src/common/errors/custom-exceptions";
import { AdmissionLimiter } from "src/modules/admission/admission-limiter";
import { EmailRepository } from "./email.repository";
import { EmailSender } from "./email.sender";
import { EmailService } from "./email.service";

describe("EmailService", () => {
  const config = { getOrThrow: jest.fn().mockReturnValue("pepper") } as unknown as ConfigService;
  const allow = () => ({ assertAllowed: jest.fn().mockResolvedValue(undefined) }) as unknown as AdmissionLimiter;

  it("issues a signup token only after a valid email code", async () => {
    const codeHash = await bcrypt.hash("user@example.com:123456:SIGNUP:pepper", 10);
    const repository = {
      latestVerification: jest.fn().mockResolvedValue({
        id: "verification",
        codeHash,
        expiresAt: new Date(Date.now() + 60_000),
        verifiedAt: null,
        attemptCount: 0,
      }),
      markVerified: jest.fn().mockResolvedValue({ id: "verification" }),
      createVerificationToken: jest.fn().mockResolvedValue(undefined),
    } as unknown as EmailRepository;
    const service = new EmailService(repository, config, {} as EmailSender, allow());

    await expect(service.verifySignupCode("USER@example.com", "123456")).resolves.toEqual({
      emailVerificationToken: expect.any(String),
    });
    expect(repository.createVerificationToken).toHaveBeenCalledWith(
      expect.any(String),
      "user@example.com",
      "SIGNUP",
      "verification",
      expect.any(Date),
    );
  });

  it("resets password only with a one-time reset token", async () => {
    const repository = {
      hasValidRecoveryToken: jest.fn().mockResolvedValue(true),
      resetPasswordWithToken: jest.fn().mockResolvedValue(true),
    } as unknown as EmailRepository;
    const service = new EmailService(repository, config, {} as EmailSender, allow());

    await expect(service.resetPassword("token", "new-password")).resolves.toEqual({ ok: true });
  });

  it("rejects admission before account lookup or delivery work", async () => {
    const repository = {
      findUserByEmail: jest.fn(),
    } as unknown as EmailRepository;
    const sender = { sendCode: jest.fn() } as unknown as EmailSender;
    const admissionLimiter = {
      assertAllowed: jest.fn().mockRejectedValue(new CustomTooManyRequestsException("요청 횟수를 초과했습니다.")),
    } as unknown as AdmissionLimiter;
    const service = new EmailService(repository, config, sender, admissionLimiter);

    await expect(service.requestPasswordResetCode("user@example.test", { ip: "127.0.0.1" })).rejects.toBeInstanceOf(
      CustomTooManyRequestsException,
    );
    expect(repository.findUserByEmail).not.toHaveBeenCalled();
    expect(sender.sendCode).not.toHaveBeenCalled();
  });

  it("rejects link admission before account lookup or delivery work", async () => {
    const repository = {
      findUserByEmail: jest.fn(),
    } as unknown as EmailRepository;
    const sender = { sendLink: jest.fn() } as unknown as EmailSender;
    const admissionLimiter = {
      assertAllowed: jest.fn().mockRejectedValue(new CustomTooManyRequestsException("요청 횟수를 초과했습니다.")),
    } as unknown as AdmissionLimiter;
    const service = new EmailService(repository, config, sender, admissionLimiter);

    await expect(service.requestPasswordReset("user@example.test", { ip: "127.0.0.1" })).rejects.toBeInstanceOf(
      CustomTooManyRequestsException,
    );
    expect(repository.findUserByEmail).not.toHaveBeenCalled();
    expect(sender.sendLink).not.toHaveBeenCalled();
  });

  it("rejects code verification before proof lookup or bcrypt work", async () => {
    const repository = {
      latestVerification: jest.fn(),
    } as unknown as EmailRepository;
    const admissionLimiter = {
      assertAllowed: jest.fn().mockRejectedValue(new CustomTooManyRequestsException("요청 횟수를 초과했습니다.")),
    } as unknown as AdmissionLimiter;
    const service = new EmailService(repository, config, {} as EmailSender, admissionLimiter);

    await expect(
      service.verifyPasswordResetCode("user@example.test", "123456", { ip: "127.0.0.1" }),
    ).rejects.toBeInstanceOf(CustomTooManyRequestsException);
    expect(repository.latestVerification).not.toHaveBeenCalled();
  });

  it("conceals password reset code delivery failures and removes the undelivered proof", async () => {
    const deleteVerification = jest.fn().mockResolvedValue(undefined);
    const knownRepository = {
      findUserByEmail: jest.fn().mockResolvedValue({ userId: "user-id", email: "user@example.test" }),
      createVerification: jest.fn().mockResolvedValue({ id: "verification-id" }),
      deleteVerification,
    } as unknown as EmailRepository;
    const failingSender = {
      sendCode: jest.fn().mockRejectedValue(new Error("delivery failed")),
    } as unknown as EmailSender;
    const unknownRepository = {
      findUserByEmail: jest.fn().mockResolvedValue(undefined),
    } as unknown as EmailRepository;
    const unusedSender = { sendCode: jest.fn() } as unknown as EmailSender;
    const knownService = new EmailService(knownRepository, config, failingSender, allow());
    const unknownService = new EmailService(unknownRepository, config, unusedSender, allow());

    const [known, unknown] = await Promise.all([
      knownService.requestPasswordResetCode("user@example.test", { ip: "127.0.0.1" }),
      unknownService.requestPasswordResetCode("unknown@example.test", { ip: "127.0.0.2" }),
    ]);

    expect(known).toEqual({ ok: true });
    expect(known).toEqual(unknown);
    expect(deleteVerification).toHaveBeenCalledWith("verification-id");
    expect(unusedSender.sendCode).not.toHaveBeenCalled();
  });

  it("conceals password reset link delivery failures and removes the undelivered token", async () => {
    const deletePasswordResetToken = jest.fn().mockResolvedValue(undefined);
    const knownRepository = {
      findUserByEmail: jest.fn().mockResolvedValue({ userId: "user-id", email: "user@example.test" }),
      createPasswordResetToken: jest.fn().mockResolvedValue(undefined),
      deletePasswordResetToken,
    } as unknown as EmailRepository;
    const failingSender = {
      sendLink: jest.fn().mockRejectedValue(new Error("delivery failed")),
    } as unknown as EmailSender;
    const unknownRepository = {
      findUserByEmail: jest.fn().mockResolvedValue(undefined),
    } as unknown as EmailRepository;
    const unusedSender = { sendLink: jest.fn() } as unknown as EmailSender;
    const knownService = new EmailService(knownRepository, config, failingSender, allow());
    const unknownService = new EmailService(unknownRepository, config, unusedSender, allow());

    const [known, unknown] = await Promise.all([
      knownService.requestPasswordReset("user@example.test", { ip: "127.0.0.1" }),
      unknownService.requestPasswordReset("unknown@example.test", { ip: "127.0.0.2" }),
    ]);

    expect(known).toEqual({ ok: true });
    expect(known).toEqual(unknown);
    expect(deletePasswordResetToken).toHaveBeenCalledWith(expect.any(String));
    expect(unusedSender.sendLink).not.toHaveBeenCalled();
  });

  it("keeps signup delivery failures observable after cleaning the proof", async () => {
    const deleteVerification = jest.fn().mockResolvedValue(undefined);
    const repository = {
      createVerification: jest.fn().mockResolvedValue({ id: "verification-id" }),
      deleteVerification,
    } as unknown as EmailRepository;
    const sender = { sendCode: jest.fn().mockRejectedValue(new Error("delivery failed")) } as unknown as EmailSender;
    const service = new EmailService(repository, config, sender, allow());

    await expect(service.requestSignupCode("user@example.test", { ip: "127.0.0.1" })).rejects.toThrow(
      "이메일 발송에 실패했습니다.",
    );
    expect(deleteVerification).toHaveBeenCalledWith("verification-id");
  });

  it("rejects an unknown recovery proof before password mutation", async () => {
    const hasValidRecoveryToken = jest.fn().mockResolvedValue(false);
    const repository = {
      hasValidRecoveryToken,
      resetPasswordWithToken: jest.fn().mockResolvedValue(true),
    } as unknown as EmailRepository;
    const service = new EmailService(repository, config, {} as EmailSender, allow());

    await expect(service.resetPassword("unknown-token", "new-password", { ip: "127.0.0.1" })).rejects.toBeInstanceOf(
      CustomUnauthorizedException,
    );
    expect(hasValidRecoveryToken).toHaveBeenCalledWith("unknown-token");
    expect(repository.resetPasswordWithToken).not.toHaveBeenCalled();
  });
});
