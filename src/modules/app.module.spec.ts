type Environment = Record<string, unknown>;

const validate = (environment: Environment) => {
  const module = jest.requireActual<typeof import("./app.module")>("./app.module") as typeof import("./app.module") & {
    validateConfig?: (value: Environment) => Environment;
  };
  return module.validateConfig?.(environment);
};

const productionEnvironment = (accessSecret: string, refreshSecret: string): Environment => ({
  NODE_ENV: "production",
  JWT_ACCESS_TOKEN_SECRET: accessSecret,
  JWT_REFRESH_TOKEN_SECRET: refreshSecret,
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
});
