import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import type { Request } from "express";
import { JwtAccessTokenStrategy } from "./access-token.strategy";
import { JwtRefreshTokenStrategy } from "./refresh-token.strategy";

const accessSecret = "access-secret-that-is-at-least-32b";
const refreshSecret = "refresh-secret-that-is-at-least-32";
const jwt = new JwtService();
const config = {
  getOrThrow: jest.fn((key: string) => (key === "JWT_ACCESS_TOKEN_SECRET" ? accessSecret : refreshSecret)),
} as unknown as ConfigService;

type AuthenticatableStrategy = {
  authenticate(request: Request, options?: object): void;
  error: (error: Error) => void;
  fail: (challenge?: unknown) => void;
  success: (user: unknown) => void;
};

const authenticate = (strategy: object, token: string) =>
  new Promise<unknown>((resolve, reject) => {
    const authenticatable = strategy as AuthenticatableStrategy;
    authenticatable.success = resolve;
    authenticatable.error = reject;
    authenticatable.fail = (challenge) =>
      reject(challenge instanceof Error ? challenge : new Error("authentication failed"));
    authenticatable.authenticate(
      {
        headers: { authorization: `Bearer ${token}` },
        cookies: {},
      } as unknown as Request,
      {},
    );
  });

const signAccess = (payload: Record<string, unknown>, issuer = "dadamjang", audience = "dadamjang-api") =>
  jwt.sign(payload, { secret: accessSecret, algorithm: "HS256", issuer, audience, expiresIn: "5m" });

const signRefresh = (payload: Record<string, unknown>) =>
  jwt.sign(payload, {
    secret: refreshSecret,
    algorithm: "HS256",
    issuer: "dadamjang",
    audience: "dadamjang-refresh",
    expiresIn: "5m",
  });

describe("JWT strategies", () => {
  it.each([
    ["refresh token use", signAccess({ userId: "user-1", role: "USER", deviceId: "device-1", tokenUse: "refresh" })],
    ["wrong issuer", signAccess({ userId: "user-1", role: "USER", tokenUse: "access" }, "other-issuer")],
    ["wrong audience", signAccess({ userId: "user-1", role: "USER", tokenUse: "access" }, "dadamjang", "other")],
    ["invalid role", signAccess({ userId: "user-1", role: "ROOT", tokenUse: "access" })],
    ["missing identifier", signAccess({ role: "USER", tokenUse: "access" })],
  ])("rejects access-token confusion from %s", async (_case, token) => {
    await expect(authenticate(new JwtAccessTokenStrategy(config), token)).rejects.toThrow();
  });

  it("accepts a narrowed access payload", async () => {
    const payload = { userId: "user-1", role: "USER", tokenUse: "access" };

    await expect(authenticate(new JwtAccessTokenStrategy(config), signAccess(payload))).resolves.toMatchObject(payload);
  });

  it.each([
    ["access token use", { userId: "user-1", role: "USER", deviceId: "device-1", tokenUse: "access" }],
    ["missing device identifier", { userId: "user-1", role: "USER", tokenUse: "refresh" }],
  ])("rejects refresh-token confusion from %s", async (_case, payload) => {
    await expect(authenticate(new JwtRefreshTokenStrategy(config), signRefresh(payload))).rejects.toThrow();
  });
});
