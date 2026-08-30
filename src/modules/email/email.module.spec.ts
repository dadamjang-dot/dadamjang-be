import { ConfigModule } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import { DatabasePool } from "src/database/connection";
import { DatabaseModule } from "src/modules/database/database.module";
import { EmailModule } from "./email.module";

describe("EmailModule", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalResendApiKey = process.env.RESEND_API_KEY;
  const originalResendFromEmail = process.env.RESEND_FROM_EMAIL;

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalResendApiKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = originalResendApiKey;
    if (originalResendFromEmail === undefined) delete process.env.RESEND_FROM_EMAIL;
    else process.env.RESEND_FROM_EMAIL = originalResendFromEmail;
  });

  it.each([
    {
      caseName: "API key is missing",
      apiKey: undefined,
      fromEmail: "sender@example.test",
      missing: ["RESEND_API_KEY"],
    },
    {
      caseName: "API key is blank",
      apiKey: "   ",
      fromEmail: "sender@example.test",
      missing: ["RESEND_API_KEY"],
    },
    {
      caseName: "sender is missing",
      apiKey: "resend-api-key",
      fromEmail: undefined,
      missing: ["RESEND_FROM_EMAIL"],
    },
    {
      caseName: "sender is blank",
      apiKey: "resend-api-key",
      fromEmail: "   ",
      missing: ["RESEND_FROM_EMAIL"],
    },
    {
      caseName: "both values are blank",
      apiKey: "   ",
      fromEmail: "   ",
      missing: ["RESEND_API_KEY", "RESEND_FROM_EMAIL"],
    },
  ])("fails production startup when $caseName", async ({ apiKey, fromEmail, missing }) => {
    process.env.NODE_ENV = "production";
    if (apiKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = apiKey;
    if (fromEmail === undefined) delete process.env.RESEND_FROM_EMAIL;
    else process.env.RESEND_FROM_EMAIL = fromEmail;
    let module: TestingModule | undefined;
    let startupError: unknown;

    try {
      module = await Test.createTestingModule({
        imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), DatabaseModule, EmailModule],
      })
        .overrideProvider(DatabasePool)
        .useValue({})
        .compile();
    } catch (error) {
      startupError = error;
    } finally {
      await module?.close();
    }

    for (const variable of missing)
      expect(startupError).toEqual(expect.objectContaining({ message: expect.stringContaining(variable) }));
  });
});
