import { requestOriginFromRequest } from "./admission-limiter";

describe("authenticated BFF request origin", () => {
  const previousSecret = process.env.DADAMJANG_BFF_SECRET;
  beforeEach(() => {
    process.env.DADAMJANG_BFF_SECRET = "a".repeat(32);
  });
  afterEach(() => {
    if (previousSecret === undefined) delete process.env.DADAMJANG_BFF_SECRET;
    else process.env.DADAMJANG_BFF_SECRET = previousSecret;
  });

  it("keeps real client IPs distinct behind the same API ALB/BFF address", () => {
    const origins = ["203.0.113.10", "2001:db8::10"].map((ip) =>
      requestOriginFromRequest({
        ip: "192.0.2.20",
        headers: {
          "x-dadamjang-client-ip": ip,
          "x-dadamjang-bff-secret": "a".repeat(32),
          "x-device-id": "device-1",
        },
      }),
    );
    expect(origins).toEqual([
      { ip: "203.0.113.10", deviceId: "device-1" },
      { ip: "2001:db8::10", deviceId: "device-1" },
    ]);
  });

  it.each([undefined, "", "spoofed", ["a".repeat(32), "spoofed"]])(
    "rejects unauthenticated BFF client-IP claims (%s)",
    (secret) => {
      expect(() =>
        requestOriginFromRequest({
          ip: "192.0.2.20",
          headers: {
            "x-dadamjang-client-ip": "203.0.113.10",
            "x-dadamjang-bff-secret": secret,
          },
        }),
      ).toThrow();
    },
  );

  it.each([undefined, "", "short-secret"])("rejects a BFF claim when the backend secret is %s", (secret) => {
    if (secret === undefined) delete process.env.DADAMJANG_BFF_SECRET;
    else process.env.DADAMJANG_BFF_SECRET = secret;
    expect(() =>
      requestOriginFromRequest({
        ip: "192.0.2.20",
        headers: {
          "x-dadamjang-client-ip": "203.0.113.10",
          "x-dadamjang-bff-secret": "a".repeat(32),
        },
      }),
    ).toThrow();
  });

  it("preserves the trusted socket/proxy IP for direct API clients", () => {
    expect(requestOriginFromRequest({ ip: "192.0.2.20", headers: { "x-forwarded-for": "spoofed" } })).toEqual({
      ip: "192.0.2.20",
    });
  });

  it.each(["203.0.113.10, 192.0.2.20", "invalid", ["203.0.113.10"]])(
    "rejects malformed authenticated IPs (%s)",
    (ip) => {
      expect(() =>
        requestOriginFromRequest({
          ip: "192.0.2.20",
          headers: {
            "x-dadamjang-client-ip": ip,
            "x-dadamjang-bff-secret": "a".repeat(32),
          },
        }),
      ).toThrow();
    },
  );
});
