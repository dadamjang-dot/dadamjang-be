import * as bcrypt from "bcrypt";
import { ConfigService } from "@nestjs/config";
import { CustomTooManyRequestsException, CustomUnauthorizedException } from "src/common/errors/custom-exceptions";
import { AdmissionLimiter } from "src/modules/admission/admission-limiter";
import { EmailRepository } from "./email.repository";
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
      verifyAndCreateProof: jest.fn().mockResolvedValue({ verificationId: "verification" }),
    } as unknown as EmailRepository;
    const service = new EmailService(repository, config, allow());

    await expect(service.verifySignupCode("USER@example.com", "123456")).resolves.toEqual({
      emailVerificationToken: expect.any(String),
    });
  });

  it("rolls back verification consumption when proof creation fails", async () => {
    const codeHash = await bcrypt.hash("user@example.com:123456:SIGNUP:pepper", 10);
    const verification = {
      id: "verification",
      codeHash,
      expiresAt: new Date(Date.now() + 60_000),
      verifiedAt: null as Date | null,
      attemptCount: 0,
    };
    let proofCreationFails = true;
    const repository = {
      latestVerification: jest.fn(async () => verification),
      verifyAndCreateProof: jest.fn(async () => {
        const previousVerifiedAt = verification.verifiedAt;
        verification.verifiedAt = new Date();
        if (proofCreationFails) {
          verification.verifiedAt = previousVerifiedAt;
          throw new Error("proof insert failed");
        }
        return { verificationId: verification.id };
      }),
    } as unknown as EmailRepository;
    const service = new EmailService(repository, config, allow());

    await expect(service.verifySignupCode("user@example.com", "123456")).rejects.toThrow("proof insert failed");
    expect(verification.verifiedAt).toBeNull();
    proofCreationFails = false;

    await expect(service.verifySignupCode("user@example.com", "123456")).resolves.toEqual({
      emailVerificationToken: expect.any(String),
    });
  });

  it("returns the same valid proof when verification is retried after response loss", async () => {
    const codeHash = await bcrypt.hash("user@example.com:123456:SIGNUP:pepper", 10);
    const verification = {
      id: "verification",
      codeHash,
      expiresAt: new Date(Date.now() + 60_000),
      verifiedAt: null as Date | null,
      attemptCount: 0,
    };
    const proofs = new Set<string>();
    const repository = {
      latestVerification: jest.fn(async () => verification),
      verifyAndCreateProof: jest.fn(async (input: { token: string }) => {
        verification.verifiedAt ??= new Date();
        proofs.add(input.token);
        return { verificationId: verification.id };
      }),
    } as unknown as EmailRepository;
    const service = new EmailService(repository, config, allow());

    const first = await service.verifySignupCode("user@example.com", "123456");
    verification.expiresAt = new Date(Date.now() - 1);
    const retried = await service.verifySignupCode("user@example.com", "123456");

    expect(retried).toEqual(first);
    expect(proofs.size).toBe(1);
  });

  it("resets password only with a one-time reset token", async () => {
    const repository = {
      hasValidRecoveryToken: jest.fn().mockResolvedValue(true),
      resetPasswordWithToken: jest.fn().mockResolvedValue(true),
    } as unknown as EmailRepository;
    const service = new EmailService(repository, config, allow());

    await expect(service.resetPassword("token", "new-password")).resolves.toEqual({ ok: true });
  });

  it("rejects admission before account lookup or delivery work", async () => {
    const repository = {
      enqueueDelivery: jest.fn(),
    } as unknown as EmailRepository;
    const admissionLimiter = {
      assertAllowed: jest.fn().mockRejectedValue(new CustomTooManyRequestsException("요청 횟수를 초과했습니다.")),
    } as unknown as AdmissionLimiter;
    const service = new EmailService(repository, config, admissionLimiter);

    await expect(service.requestPasswordResetCode("user@example.test", { ip: "127.0.0.1" })).rejects.toBeInstanceOf(
      CustomTooManyRequestsException,
    );
    expect(repository.enqueueDelivery).not.toHaveBeenCalled();
  });

  it("rejects link admission before account lookup or delivery work", async () => {
    const repository = {
      enqueueDelivery: jest.fn(),
    } as unknown as EmailRepository;
    const admissionLimiter = {
      assertAllowed: jest.fn().mockRejectedValue(new CustomTooManyRequestsException("요청 횟수를 초과했습니다.")),
    } as unknown as AdmissionLimiter;
    const service = new EmailService(repository, config, admissionLimiter);

    await expect(service.requestPasswordReset("user@example.test", { ip: "127.0.0.1" })).rejects.toBeInstanceOf(
      CustomTooManyRequestsException,
    );
    expect(repository.enqueueDelivery).not.toHaveBeenCalled();
  });

  it("rejects code verification before proof lookup or bcrypt work", async () => {
    const repository = {
      latestVerification: jest.fn(),
    } as unknown as EmailRepository;
    const admissionLimiter = {
      assertAllowed: jest.fn().mockRejectedValue(new CustomTooManyRequestsException("요청 횟수를 초과했습니다.")),
    } as unknown as AdmissionLimiter;
    const service = new EmailService(repository, config, admissionLimiter);

    await expect(
      service.verifyPasswordResetCode("user@example.test", "123456", { ip: "127.0.0.1" }),
    ).rejects.toBeInstanceOf(CustomTooManyRequestsException);
    expect(repository.latestVerification).not.toHaveBeenCalled();
  });

  it("queues signup codes without creating proofs or awaiting delivery", async () => {
    const enqueueDelivery = jest.fn().mockResolvedValue(undefined);
    const repository = {
      enqueueDelivery,
    } as unknown as EmailRepository;
    const service = new EmailService(repository, config, allow());

    await expect(service.requestSignupCode("user@example.test", { ip: "127.0.0.1" })).resolves.toEqual({ ok: true });
    expect(enqueueDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "user@example.test",
        kind: "SIGNUP_CODE",
        requestIpHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
  });

  it("queues identical recovery work before any account lookup or delivery", async () => {
    const enqueueDelivery = jest.fn().mockResolvedValue(undefined);
    const repository = {
      enqueueDelivery,
    } as unknown as EmailRepository;
    const service = new EmailService(repository, config, allow());

    await expect(
      Promise.all([
        service.requestPasswordResetCode("user@example.test", { ip: "127.0.0.1" }),
        service.requestPasswordResetCode("unknown@example.test", { ip: "127.0.0.2" }),
        service.requestPasswordReset("user@example.test", { ip: "127.0.0.3" }),
        service.requestPasswordReset("unknown@example.test", { ip: "127.0.0.4" }),
      ]),
    ).resolves.toEqual(Array.from({ length: 4 }, () => ({ ok: true })));
    expect(enqueueDelivery.mock.calls.map(([input]) => input.kind)).toEqual([
      "PASSWORD_RESET_CODE",
      "PASSWORD_RESET_CODE",
      "PASSWORD_RESET_LINK",
      "PASSWORD_RESET_LINK",
    ]);
  });

  it("rejects an unknown recovery proof before password mutation", async () => {
    const hasValidRecoveryToken = jest.fn().mockResolvedValue(false);
    const repository = {
      hasValidRecoveryToken,
      resetPasswordWithToken: jest.fn().mockResolvedValue(true),
    } as unknown as EmailRepository;
    const service = new EmailService(repository, config, allow());

    await expect(service.resetPassword("unknown-token", "new-password", { ip: "127.0.0.1" })).rejects.toBeInstanceOf(
      CustomUnauthorizedException,
    );
    expect(hasValidRecoveryToken).toHaveBeenCalledWith("unknown-token");
    expect(repository.resetPasswordWithToken).not.toHaveBeenCalled();
  });

  it("rejects a stale recovery proof for a passwordless account", async () => {
    const repository = {
      hasValidRecoveryToken: jest.fn().mockResolvedValue(true),
      resetPasswordWithToken: jest.fn().mockResolvedValue(false),
    } as unknown as EmailRepository;
    const service = new EmailService(repository, config, allow());

    await expect(service.resetPassword("stale-token", "new-password")).rejects.toBeInstanceOf(
      CustomUnauthorizedException,
    );
  });
});
