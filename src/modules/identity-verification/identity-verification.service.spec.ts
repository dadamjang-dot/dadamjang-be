import { ConfigService } from "@nestjs/config";
import { hashToken } from "src/common/security/token-hash";
import { AdmissionLimiter, type RequestOrigin } from "src/modules/admission/admission-limiter";
import { InicisIdentityAdapter } from "./inicis-identity.adapter";
import { IdentityVerificationRepository } from "./identity-verification.repository";
import { IdentityVerificationService } from "./identity-verification.service";

const config = {
  getOrThrow: jest.fn().mockReturnValue("identity-pepper"),
  get: jest.fn((key: string) => (key === "NODE_ENV" ? "test" : undefined)),
} as unknown as ConfigService;
const admissionLimiter = {
  assertAllowed: jest.fn().mockResolvedValue(undefined),
} as unknown as AdmissionLimiter;

const pendingSession = {
  sessionId: "session-1",
  purpose: "SIGNUP",
  provider: "KAKAO",
  deviceIdHash: "device-hash",
  merchantTransactionId: "merchant-1",
  providerTransactionId: null,
  status: "PENDING",
  failureCode: null,
  ciHash: null,
  certificateProvider: null,
  isFourteenOrOlder: null,
  proofTokenHash: null,
  callbackTokenHash: null,
  expiresAt: new Date(Date.now() + 60_000),
  verifiedAt: null,
  completedAt: null,
  consumedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("IdentityVerificationService", () => {
  it("does not persist a session when start admission is rejected", async () => {
    let inserts = 0;
    const repository = {
      createSession: async () => {
        inserts += 1;
        return pendingSession;
      },
    } as unknown as IdentityVerificationRepository;
    const admissionLimiter = {
      assertAllowed: async () => {
        throw new Error("admission rejected");
      },
    } as unknown as AdmissionLimiter;
    const Service = IdentityVerificationService as unknown as new (
      repository: IdentityVerificationRepository,
      adapter: InicisIdentityAdapter,
      configService: ConfigService,
      admissionLimiter: AdmissionLimiter,
    ) => IdentityVerificationService;
    const service = new Service(repository, {} as InicisIdentityAdapter, config, admissionLimiter);
    const start = service.start as unknown as (
      input: { purpose: "SIGNUP"; provider: "KAKAO" },
      deviceId: string,
      origin: RequestOrigin,
    ) => Promise<object>;

    await expect(
      start({ purpose: "SIGNUP", provider: "KAKAO" }, "device-1", {
        ip: "203.0.113.10",
        deviceId: "device-1",
      }),
    ).rejects.toThrow("admission rejected");
    expect(inserts).toBe(0);
  });

  it("records under-fourteen results without retaining raw identity data", async () => {
    const repository = {
      findSession: jest.fn().mockResolvedValue(pendingSession),
      markVerified: jest.fn().mockImplementation(async (input) => ({
        ...pendingSession,
        status: "VERIFIED",
        ...input,
      })),
    } as unknown as IdentityVerificationRepository;
    const adapter = {
      verify: jest.fn().mockResolvedValue({
        ci: "raw-ci",
        birthday: "20200101",
        certificateProvider: "KAKAO",
      }),
    } as unknown as InicisIdentityAdapter;
    const service = new IdentityVerificationService(repository, adapter, config, admissionLimiter);

    const result = (await service.callback("session-1", {
      resultCode: "0000",
      authRequestUrl: "https://fcsa.inicis.com/result",
      transactionId: "transaction-1",
      token: "token",
    })) as unknown as { callbackToken: string };

    expect(result).toEqual(expect.objectContaining({ callbackToken: expect.any(String) }));
    expect(repository.markVerified).toHaveBeenCalledWith({
      sessionId: "session-1",
      ciHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      certificateProvider: "KAKAO",
      isFourteenOrOlder: false,
      callbackTokenHash: hashToken(result.callbackToken),
    });
    expect(repository.markVerified).not.toHaveBeenCalledWith(
      expect.objectContaining({ ci: "raw-ci", birthday: "20200101" }),
    );
  });

  it("does not accept an impossible birthday as an adult", async () => {
    const repository = {
      findSession: jest.fn().mockResolvedValue(pendingSession),
      markVerified: jest.fn().mockImplementation(async (input) => ({
        ...pendingSession,
        status: "VERIFIED",
        ...input,
      })),
    } as unknown as IdentityVerificationRepository;
    const adapter = {
      verify: jest.fn().mockResolvedValue({
        ci: "raw-ci",
        birthday: "20000231",
        certificateProvider: "KAKAO",
      }),
    } as unknown as InicisIdentityAdapter;
    const service = new IdentityVerificationService(repository, adapter, config, admissionLimiter);

    await service.callback("session-1", { resultCode: "0000" });

    expect(repository.markVerified).toHaveBeenCalledWith(expect.objectContaining({ isFourteenOrOlder: false }));
  });

  it("does not reveal another callback token for an already verified session", async () => {
    const verifiedSession = { ...pendingSession, status: "VERIFIED" };
    const repository = {
      findSession: jest.fn().mockResolvedValue(verifiedSession),
    } as unknown as IdentityVerificationRepository;
    const adapter = { verify: jest.fn() } as unknown as InicisIdentityAdapter;
    const service = new IdentityVerificationService(repository, adapter, config, admissionLimiter);

    await expect(service.callback("session-1", { resultCode: "0000" })).rejects.toThrow();
    expect(adapter.verify).not.toHaveBeenCalled();
  });

  it("binds completion to the callback token and consumes it once", async () => {
    let consumed = false;
    const repository = {
      completeSession: jest.fn(async (_sessionId: string, deviceIdHash: string, presentedCallbackToken: string) => {
        if (
          deviceIdHash !== hashToken("device-b") ||
          presentedCallbackToken !== "token-seen-only-by-device-b" ||
          consumed
        )
          return undefined;
        consumed = true;
        return pendingSession;
      }),
    } as unknown as IdentityVerificationRepository;
    const service = new IdentityVerificationService(repository, {} as InicisIdentityAdapter, config, admissionLimiter);
    const complete = service.complete as unknown as (
      sessionId: string,
      deviceId: string,
      callbackToken: string,
    ) => Promise<object>;

    await expect(complete("identity-session", "device-a", "token-seen-only-by-device-b")).rejects.toThrow();
    await expect(complete("identity-session", "device-b", "token-seen-only-by-device-b")).resolves.toEqual({
      identityVerificationToken: expect.any(String),
    });
    await expect(complete("identity-session", "device-b", "token-seen-only-by-device-b")).rejects.toThrow();
  });

  it("marks a pending session failed when result verification fails", async () => {
    const repository = {
      findSession: jest.fn().mockResolvedValue(pendingSession),
      markFailed: jest.fn().mockResolvedValue(undefined),
    } as unknown as IdentityVerificationRepository;
    const adapter = {
      verify: jest.fn().mockRejectedValue(new Error("invalid callback")),
    } as unknown as InicisIdentityAdapter;
    const service = new IdentityVerificationService(repository, adapter, config, admissionLimiter);

    await expect(service.callback("session-1", { resultCode: "1001" })).rejects.toThrow("invalid callback");
    expect(repository.markFailed).toHaveBeenCalledWith("session-1", "1001");
  });
});
