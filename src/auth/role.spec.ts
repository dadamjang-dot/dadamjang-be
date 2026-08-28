import { hasBuyerCapability, UserRole } from "./role";

describe("hasBuyerCapability", () => {
  it.each([
    [UserRole.User, true],
    [UserRole.Partner, true],
    [UserRole.Admin, false],
  ] as const)("marks %s buyer capability as %s", (role, expected) => {
    expect(hasBuyerCapability(role)).toBe(expected);
  });
});
