import * as bcrypt from "bcrypt";
import { AuthErrorMessage } from "./auth.error";
import { AuthService } from "./auth.service";
import { AuthPortal } from "./auth.types";

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
  new AuthService(repository as never, {} as never, {} as never, emailService as never);

describe("AuthService", () => {
  it("rejects signin through a portal that does not match the user role", async () => {
    const password = await bcrypt.hash("password", 4);
    const service = createService(
      { findByUserid: jest.fn().mockResolvedValue({ ...user, password }) },
      {
        normalizeUserid: (value: string) => value,
      },
    );
    await expect(
      service.signin({ userid: "user", password: "password", portal: AuthPortal.Partner }, "device"),
    ).rejects.toThrow(AuthErrorMessage.AuthRequired);
  });

  it("rejects expired and invalid refresh tokens", async () => {
    const expired = createService({
      findRefreshToken: jest.fn().mockResolvedValue({ refreshToken: "hash", refreshTokenExp: new Date(0) }),
    });
    await expect(expired.refresh("user-1", "device", "token")).rejects.toThrow(AuthErrorMessage.AuthRequired);
    const hash = await bcrypt.hash("different-token", 4);
    const invalid = createService({
      findRefreshToken: jest
        .fn()
        .mockResolvedValue({ refreshToken: hash, refreshTokenExp: new Date(Date.now() + 60_000) }),
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
});
