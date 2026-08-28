import { requireResult } from "./require-result";

describe("requireResult", () => {
  it("returns a present operation result", () => {
    expect(requireResult({ id: "result-1" })).toEqual({ id: "result-1" });
  });

  it("throws a stable internal error when a required result is missing", () => {
    expect(() => requireResult(undefined)).toThrow("Required operation result is missing");
  });
});
