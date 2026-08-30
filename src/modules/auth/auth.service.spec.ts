import * as bcrypt from "bcrypt";
import { AdmissionLimiter, type RequestOrigin } from "src/modules/admission/admission-limiter";
import { AuthErrorMessage } from "./auth.error";
import { AuthService } from "./auth.service";
import { AuthPortal } from "./auth.types";

jest.mock("bcrypt", () => {
  const actual = jest.requireActual<typeof import("bcrypt")>("bcrypt");
  return { ...actual, compare: jest.fn(actual.compare) };
});

const actualCompare = jest.requireActual<typeof import("bcrypt")>("bcrypt").compare;

const user = {
  userId: "user-1",
  userid: "user",
  email: "user@example.test",
  password: "",
  role: "USER",
  createdAt: new Date(),
  updatedAt: new Date(),
};

const createService = (repository: object, emailService: object = {}) =>
  new AuthService(
    repository as never,
    {} as never,
    {} as never,
    emailService as never,
    {
      assertAllowed: jest.fn().mockResolvedValue(undefined),
    } as never,
  );

const createAdmissionService = (repository: object, emailService: object, admissionLimiter: object) => {
  const Service = AuthService as unknown as new (
    repository: never,
    jwtService: never,
    configService: never,
    emailService: never,
    admissionLimiter: never,
  ) => AuthService;
  return new Service(repository as never, {} as never, {} as never, emailService as never, admissionLimiter as never);
};

describe("AuthService", () => {
  it("runs admission before userid lookup and password comparison", async () => {
    const order: string[] = [];
    const compare = jest.mocked(bcrypt.compare).mockImplementation(async () => {
      order.push("bcrypt");
      return true;
    });
    const repository = {
      signinStartedAt: jest.fn().mockResolvedValue(new Date()),
      findByUserid: jest.fn().mockImplementation(async () => {
        order.push("lookup");
        return { ...user, role: "ADMIN" };
      }),
      withSigninLock: jest.fn(
        async (_userId: string, _deviceId: string, action: (store: undefined) => Promise<unknown>) => ({
          acquired: true,
          value: await action(undefined),
        }),
      ),
      findRefreshToken: jest.fn().mockResolvedValue(undefined),
      saveRefreshToken: jest.fn().mockResolvedValue(true),
    };
    const admissionLimiter = {
      assertAllowed: jest.fn().mockImplementation(async () => {
        order.push("admission");
      }),
    } as unknown as AdmissionLimiter;
    const service = createAdmissionService(
      repository,
      { normalizeUserid: (value: string) => value.trim().toLowerCase() },
      admissionLimiter,
    );
    service.issueTokensForUser = jest.fn().mockResolvedValue({ role: "ADMIN" }) as never;
    const signin = service.signin as unknown as (
      input: { userid: string; password: string; portal: AuthPortal },
      deviceId: string,
      origin: RequestOrigin,
    ) => Promise<object>;

    try {
      await signin({ userid: " ADMIN ", password: "password", portal: AuthPortal.Bo }, "device-1", {
        ip: "203.0.113.10",
        deviceId: "device-1",
      });
      expect(order).toEqual(["admission", "lookup", "bcrypt"]);
    } finally {
      compare.mockImplementation(actualCompare);
    }
  });

  it("uses literal IP, normalized account, and device scopes with lower privileged-portal limits", async () => {
    const assertAllowed = jest.fn().mockResolvedValue(undefined);
    const admissionLimiter = {
      assertAllowed,
    } as unknown as AdmissionLimiter;
    const repository = {
      signinStartedAt: jest.fn().mockResolvedValue(new Date()),
      findByUserid: jest.fn().mockResolvedValue(undefined),
    };
    const service = createAdmissionService(
      repository,
      { normalizeUserid: (value: string) => value.trim().toLowerCase() },
      admissionLimiter,
    );
    const signin = service.signin as unknown as (
      input: { userid: string; password: string; portal: AuthPortal },
      deviceId: string,
      origin: RequestOrigin,
    ) => Promise<object>;
    const origin = { ip: "203.0.113.10", deviceId: "device-1" };

    await expect(
      signin({ userid: " MEMBER ", password: "wrong", portal: AuthPortal.Fo }, "device-1", origin),
    ).rejects.toThrow(AuthErrorMessage.AuthRequired);
    await expect(
      signin({ userid: " MEMBER ", password: "wrong", portal: AuthPortal.Partner }, "device-1", origin),
    ).rejects.toThrow(AuthErrorMessage.AuthRequired);
    await expect(
      signin({ userid: " MEMBER ", password: "wrong", portal: AuthPortal.Bo }, "device-1", origin),
    ).rejects.toThrow(AuthErrorMessage.AuthRequired);

    expect(admissionLimiter.assertAllowed).toHaveBeenNthCalledWith(
      1,
      "AUTH_SIGNIN_FO",
      [
        { scopeType: "signin-ip", value: "203.0.113.10", limit: 20, windowMs: 900_000 },
        { scopeType: "signin-account", value: "member", limit: 20, windowMs: 900_000 },
        { scopeType: "signin-device", value: "device-1", limit: 20, windowMs: 900_000 },
      ],
      AuthErrorMessage.AuthRequired,
    );
    for (const [index, portal] of ["PARTNER", "BO"].entries()) {
      const [action, rules] = assertAllowed.mock.calls[index + 1] ?? [];
      expect(action).toBe(`AUTH_SIGNIN_${portal}`);
      expect(rules).toEqual([
        { scopeType: "signin-ip", value: "203.0.113.10", limit: 5, windowMs: 900_000 },
        { scopeType: "signin-account", value: "member", limit: 5, windowMs: 900_000 },
        { scopeType: "signin-device", value: "device-1", limit: 5, windowMs: 900_000 },
      ]);
    }
  });

  it("rejects signin through a portal that does not match the user role", async () => {
    const password = await bcrypt.hash("password", 4);
    const service = createService(
      {
        signinStartedAt: jest.fn().mockResolvedValue(new Date()),
        findByUserid: jest.fn().mockResolvedValue({ ...user, password }),
        withSigninLock: jest.fn(
          async (_userId: string, _deviceId: string, action: (store: undefined) => Promise<unknown>) => ({
            acquired: true,
            value: await action(undefined),
          }),
        ),
      },
      {
        normalizeUserid: (value: string) => value,
      },
    );
    await expect(
      service.signin({ userid: "user", password: "password", portal: AuthPortal.Partner }, "device", {
        ip: "unknown",
        deviceId: "device",
      }),
    ).rejects.toThrow(AuthErrorMessage.AuthRequired);
  });

  it("rejects expired and invalid refresh tokens", async () => {
    const expired = createService({
      findRefreshToken: jest.fn().mockResolvedValue({ refreshToken: "hash", refreshTokenExp: new Date(0) }),
      hasRecentRotation: jest.fn().mockResolvedValue(false),
    });
    await expect(expired.refresh("user-1", "device", "token")).rejects.toThrow(AuthErrorMessage.AuthRequired);
    const hash = await bcrypt.hash("different-token", 4);
    const invalid = createService({
      findRefreshToken: jest
        .fn()
        .mockResolvedValue({ refreshToken: hash, refreshTokenExp: new Date(Date.now() + 60_000) }),
      hasRecentRotation: jest.fn().mockResolvedValue(false),
    });
    await expect(invalid.refresh("user-1", "device", "token")).rejects.toThrow(AuthErrorMessage.AuthRequired);
  });

  it("deletes the current device refresh token on logout", async () => {
    const refreshToken = "current-token";
    const refreshTokenHash = await bcrypt.hash(refreshToken, 4);
    const deleteRefreshToken = jest.fn().mockResolvedValue(true);
    const service = createService({
      deleteRefreshToken,
      findRefreshToken: jest
        .fn()
        .mockResolvedValue({ refreshToken: refreshTokenHash, refreshTokenExp: new Date(Date.now() + 60_000) }),
    });
    await expect(service.logout("user-1", "device", refreshToken)).resolves.toBe(true);
    expect(deleteRefreshToken).toHaveBeenCalledWith("user-1", "device", refreshTokenHash);
  });

  it("issues distinct access tokens and persists them with compare-and-swap", async () => {
    const repository = {
      findRefreshToken: jest.fn().mockResolvedValue(undefined),
      saveRefreshToken: jest.fn().mockResolvedValue(true),
    };
    const jwtService = {
      signAsync: jest.fn(async (payload: object) => Buffer.from(JSON.stringify(payload)).toString("base64url")),
      decode: jest.fn().mockReturnValue({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    };
    const configService = {
      getOrThrow: jest.fn((name: string) => (name.endsWith("EXP") ? "1h" : "secret")),
    };
    const service = new AuthService(
      repository as never,
      jwtService as never,
      configService as never,
      {} as never,
      {
        assertAllowed: jest.fn().mockResolvedValue(undefined),
      } as never,
    );

    const [first, second] = await Promise.all([
      service.issueTokensForUser(user, "device"),
      service.issueTokensForUser(user, "device"),
    ]);

    expect(first.accessToken).not.toBe(second.accessToken);
    expect(repository.saveRefreshToken).toHaveBeenCalledTimes(2);
    expect(repository.saveRefreshToken.mock.calls[0]?.[0]).not.toHaveProperty("previousRefreshToken");
    expect(repository.saveRefreshToken).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: "device" }),
      undefined,
    );
  });

  it("issues HS256 access and refresh tokens with distinct typed claims", async () => {
    const repository = {
      findRefreshToken: jest.fn().mockResolvedValue(undefined),
      saveRefreshToken: jest.fn().mockResolvedValue(true),
    };
    const jwtService = {
      signAsync: jest.fn().mockResolvedValueOnce("access-token").mockResolvedValueOnce("refresh-token"),
      decode: jest.fn().mockReturnValue({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    };
    const configService = {
      getOrThrow: jest.fn((name: string) => {
        const values: Record<string, string> = {
          JWT_ACCESS_TOKEN_SECRET: "access-secret",
          JWT_ACCESS_TOKEN_EXP: "15m",
          JWT_REFRESH_TOKEN_SECRET: "refresh-secret",
          JWT_REFRESH_TOKEN_EXP: "7d",
        };
        return values[name];
      }),
    };
    const service = new AuthService(
      repository as never,
      jwtService as never,
      configService as never,
      {} as never,
      {
        assertAllowed: jest.fn().mockResolvedValue(undefined),
      } as never,
    );

    await service.issueTokensForUser(user, "device-1");

    expect(jwtService.signAsync).toHaveBeenNthCalledWith(1, expect.objectContaining({ tokenUse: "access" }), {
      secret: "access-secret",
      expiresIn: "15m",
      algorithm: "HS256",
      issuer: "dadamjang",
      audience: "dadamjang-api",
    });
    expect(jwtService.signAsync).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ tokenUse: "refresh", deviceId: "device-1" }),
      {
        secret: "refresh-secret",
        expiresIn: "7d",
        algorithm: "HS256",
        issuer: "dadamjang",
        audience: "dadamjang-refresh",
      },
    );
  });
});
