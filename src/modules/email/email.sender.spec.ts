import { Logger } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { DevEmailSender, ResendEmailSender } from "./email.sender";

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

describe("ResendEmailSender", () => {
  it("trims configured credentials before delivery", async () => {
    const send = jest.spyOn(global, "fetch").mockResolvedValue({ ok: true } as Response);
    const values: Record<string, string> = {
      RESEND_API_KEY: "  resend-api-key  ",
      RESEND_FROM_EMAIL: "  sender@example.test  ",
    };
    const sender = new ResendEmailSender({
      getOrThrow: jest.fn((key: string) => values[key]),
    } as unknown as ConfigService);

    try {
      await sender.sendCode("recipient@example.test", "123456");
      const request = send.mock.calls[0][1];
      expect(request?.headers).toEqual({
        authorization: "Bearer resend-api-key",
        "content-type": "application/json",
      });
      expect(JSON.parse(String(request?.body))).toEqual(
        expect.objectContaining({ from: "sender@example.test", to: ["recipient@example.test"] }),
      );
    } finally {
      send.mockRestore();
    }
  });
});
