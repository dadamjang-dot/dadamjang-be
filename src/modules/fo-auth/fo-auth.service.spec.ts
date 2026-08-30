import * as bcrypt from "bcrypt";
import { AdmissionLimiter, type RequestOrigin } from "src/modules/admission/admission-limiter";
import { UserRole } from "src/auth/role";
import { AuthService } from "src/modules/auth/auth.service";
import { EmailService } from "src/modules/email/email.service";
import { FoAuthRepository } from "./fo-auth.repository";
import { FoAuthService } from "./fo-auth.service";

jest.mock("bcrypt", () => {
  const actual = jest.requireActual<typeof import("bcrypt")>("bcrypt");
  return { ...actual, compare: jest.fn(actual.compare) };
});

const actualCompare = jest.requireActual<typeof import("bcrypt")>("bcrypt").compare;

const user = {
  userId: "10000000-0000-4000-8000-000000000001",
  userid: "user",
  email: "member@example.test",
  password: "hash",
  role: UserRole.User,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const createService = (repository: object, authService: object, emailService: object, admissionLimiter: object) => {
  const Service = FoAuthService as unknown as new (
    repository: FoAuthRepository,
    authService: AuthService,
    emailService: EmailService,
    admissionLimiter: AdmissionLimiter,
  ) => FoAuthService;
  return new Service(
    repository as FoAuthRepository,
    authService as AuthService,
    emailService as EmailService,
    admissionLimiter as AdmissionLimiter,
  );
};

describe("FoAuthService", () => {
  it("admits literal IP, normalized account, and device scopes before lookup and bcrypt", async () => {
    const order: string[] = [];
    const compare = jest.mocked(bcrypt.compare).mockImplementation(async () => {
      order.push("bcrypt");
      return true;
    });
    const repository = {
      findByEmail: jest.fn().mockImplementation(async () => {
        order.push("lookup");
        return user;
      }),
    };
    const authService = {
      signinStartedAt: jest.fn().mockResolvedValue(new Date()),
      withSigninLock: jest.fn(
        async (_userId: string, _deviceId: string, action: (store: undefined) => Promise<unknown>) => action(undefined),
      ),
      issueTokensForUser: jest.fn().mockResolvedValue({ role: UserRole.User }),
    };
    const admissionLimiter = {
      assertAllowed: jest.fn().mockImplementation(async () => {
        order.push("admission");
      }),
    };
    const service = createService(
      repository,
      authService,
      { normalizeEmail: (value: string) => value.trim().toLowerCase() },
      admissionLimiter,
    );
    const signin = service.signin as unknown as (
      input: { email: string; password: string },
      deviceId: string,
      origin: RequestOrigin,
    ) => Promise<object>;

    try {
      await signin({ email: " MEMBER@EXAMPLE.TEST ", password: "password" }, "device-1", {
        ip: "203.0.113.10",
        deviceId: "device-1",
      });
      expect(order).toEqual(["admission", "lookup", "bcrypt"]);
      expect(admissionLimiter.assertAllowed).toHaveBeenCalledWith(
        "AUTH_SIGNIN_FO",
        [
          { scopeType: "signin-ip", value: "203.0.113.10", limit: 20, windowMs: 900_000 },
          { scopeType: "signin-account", value: "member@example.test", limit: 20, windowMs: 900_000 },
          { scopeType: "signin-device", value: "device-1", limit: 20, windowMs: 900_000 },
        ],
        "이메일 또는 비밀번호가 올바르지 않습니다.",
      );
    } finally {
      compare.mockImplementation(actualCompare);
    }
  });
});
