import { Logger } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { DevEmailSender } from "./email.sender";

describe("DevEmailSender", () => {
  it("does not write email secrets to logs", async () => {
    const log = jest.spyOn(Logger.prototype, "log").mockImplementation();
    const sender = new DevEmailSender({ get: jest.fn() } as unknown as ConfigService);

    try {
      await sender.sendCode("user@example.test", "123456");
      await sender.sendLink("user@example.test", "비밀번호 재설정", "https://example.test/reset#token=reset-secret");
      const output = log.mock.calls.flat().join(" ");
      expect(output).not.toContain("123456");
      expect(output).not.toContain("reset-secret");
    } finally {
      log.mockRestore();
    }
  });
});
