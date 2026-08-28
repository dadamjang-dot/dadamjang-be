import type { Request } from "express";
import { CustomBadRequestException } from "src/common/errors/custom-exceptions";
import { deviceIdFromRequest } from "./auth-http";

describe("deviceIdFromRequest", () => {
  it("rejects device identifiers that cannot fit the session record", () => {
    const request = { headers: { "x-device-id": "x".repeat(256) } } as unknown as Request;

    expect(() => deviceIdFromRequest(request)).toThrow(CustomBadRequestException);
  });
});
