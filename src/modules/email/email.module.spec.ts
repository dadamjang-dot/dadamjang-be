import { ConfigModule } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import { DatabaseModule } from "src/modules/database/database.module";
import { EmailModule } from "./email.module";

describe("EmailModule", () => {
  it("fails startup when production email delivery is not configured", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousResendApiKey = process.env.RESEND_API_KEY;
    process.env.NODE_ENV = "production";
    delete process.env.RESEND_API_KEY;
    let module: TestingModule | undefined;
    let startupError: unknown;

    try {
      module = await Test.createTestingModule({
        imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), DatabaseModule, EmailModule],
      }).compile();
    } catch (error) {
      startupError = error;
    } finally {
      await module?.close();
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousResendApiKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = previousResendApiKey;
    }

    expect(startupError).toEqual(expect.objectContaining({ message: expect.stringContaining("RESEND_API_KEY") }));
  });
});
