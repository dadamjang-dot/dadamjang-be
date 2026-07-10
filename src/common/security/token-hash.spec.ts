import { hashToken } from "./token-hash";

describe("hashToken", () => {
  it("returns a deterministic sha256 hex digest", () => {
    expect(hashToken("signup-token")).toBe("932739eece2b7d31922b6d13a4a5f9caa895139a7d8bc549472a5682b624f9b5");
  });
});
