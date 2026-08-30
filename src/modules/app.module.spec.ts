type Environment = Record<string, unknown>;

const validate = (environment: Environment) => {
  const module = jest.requireActual<typeof import("./app.module")>("./app.module") as typeof import("./app.module") & {
    validateConfig?: (value: Environment) => Environment;
  };
  return module.validateConfig?.(environment);
};

const validEmailPepper = "8spGDGxV2zX4YqH7N5mTJhKpR9cW6bLf";
const validIdentityPepper = "Q4vZw8nC7jF2sMx5D9kLpR6tY3hGbN1a";

const productionEnvironment = (
  accessSecret: string,
  refreshSecret: string,
  overrides: Environment = {},
): Environment => ({
  NODE_ENV: "production",
  JWT_ACCESS_TOKEN_SECRET: accessSecret,
  JWT_REFRESH_TOKEN_SECRET: refreshSecret,
  EMAIL_CODE_PEPPER: validEmailPepper,
  IDENTITY_CI_PEPPER: validIdentityPepper,
  ...overrides,
});

describe("validateConfig", () => {
  it.each([
    ["placeholder", "replace-me", "r".repeat(32)],
    ["short secret", "a".repeat(31), "r".repeat(32)],
    ["equal secrets", "s".repeat(32), "s".repeat(32)],
  ])("rejects production %s", (_case, accessSecret, refreshSecret) => {
    expect(() => validate(productionEnvironment(accessSecret, refreshSecret))).toThrow();
  });

  it("accepts distinct production secrets of at least 32 bytes", () => {
    const environment = productionEnvironment("a".repeat(32), "r".repeat(32));

    expect(validate(environment)).toBe(environment);
  });

  it.each([
    ["missing email pepper", { EMAIL_CODE_PEPPER: undefined }],
    ["missing identity pepper", { IDENTITY_CI_PEPPER: undefined }],
    ["email placeholder", { EMAIL_CODE_PEPPER: "replace-me" }],
    ["identity placeholder", { IDENTITY_CI_PEPPER: "replace-me" }],
    ["documented email placeholder", { EMAIL_CODE_PEPPER: "generate-with-openssl-rand-base64-32" }],
    ["documented identity placeholder", { IDENTITY_CI_PEPPER: "generate-with-openssl-rand-base64-32" }],
    ["short email pepper", { EMAIL_CODE_PEPPER: "e".repeat(31) }],
    ["short identity pepper", { IDENTITY_CI_PEPPER: "i".repeat(31) }],
    ["equal peppers", { EMAIL_CODE_PEPPER: validEmailPepper, IDENTITY_CI_PEPPER: validEmailPepper }],
  ])("rejects production %s", (_case, overrides) => {
    expect(() => validate(productionEnvironment("a".repeat(32), "r".repeat(32), overrides))).toThrow();
  });
});
