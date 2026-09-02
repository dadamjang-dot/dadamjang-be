import type { ConfigService } from "@nestjs/config";
import { decryptEmailPayload, EmailDeliveryWorker, encryptEmailPayload } from "./email.outbox";
import type { EmailRepository } from "./email.repository";
import type { EmailSender } from "./email.sender";

describe("email outbox payload encryption", () => {
  it("round-trips a secret without storing it in plaintext", () => {
    const ciphertext = encryptEmailPayload("sensitive-reset-token", "outbox-key-material");

    expect(ciphertext).not.toContain("sensitive-reset-token");
    expect(decryptEmailPayload(ciphertext, "outbox-key-material")).toBe("sensitive-reset-token");
  });

  it("rejects tampered ciphertext and the wrong key", () => {
    const ciphertext = encryptEmailPayload("123456", "outbox-key-material");
    const [nonce, tag, encrypted] = ciphertext.split(".");
    if (!nonce || !tag || !encrypted) throw new Error("invalid encryption fixture");
    const tampered = Buffer.from(tag, "base64url");
    tampered[0] = (tampered[0] ?? 0) ^ 1;

    expect(() =>
      decryptEmailPayload(`${nonce}.${tampered.toString("base64url")}.${encrypted}`, "outbox-key-material"),
    ).toThrow();
    expect(() => decryptEmailPayload(ciphertext, "wrong-key-material")).toThrow();
  });
});

describe("EmailDeliveryWorker", () => {
  it("suppresses a claimed unsupported delivery kind before email dispatch", async () => {
    const now = new Date("2026-09-03T00:00:00.000Z");
    const repository = {
      scrubTerminalDeliveries: jest.fn().mockResolvedValue(0),
      purgeTerminalDeliveries: jest.fn().mockResolvedValue(0),
      claimDelivery: jest.fn().mockResolvedValue({
        id: "10000000-0000-4000-8000-000000000001",
        kind: "UNSUPPORTED",
        email: "unsupported@example.test",
        requestIpHash: "a".repeat(64),
        payloadCiphertext: null,
        proofId: null,
        status: "PROCESSING",
        attemptCount: 1,
        availableAt: now,
        claimedAt: now,
        claimToken: "20000000-0000-4000-8000-000000000001",
        expiresAt: new Date("2026-09-03T00:10:00.000Z"),
        sentAt: null,
        lastError: "unsupported-email-kind",
        createdAt: now,
        updatedAt: now,
      }),
      suppressDelivery: jest.fn().mockResolvedValue(undefined),
      retryDelivery: jest.fn().mockResolvedValue(undefined),
    } as unknown as EmailRepository;
    const sender = {
      sendCode: jest.fn(),
      sendLink: jest.fn(),
    } as unknown as EmailSender;
    const worker = new EmailDeliveryWorker(
      repository,
      { getOrThrow: jest.fn().mockReturnValue("pepper") } as unknown as ConfigService,
      sender,
    );

    await expect(worker.runOnce(now)).resolves.toBe(true);

    expect(repository.suppressDelivery).toHaveBeenCalledWith(
      "10000000-0000-4000-8000-000000000001",
      "20000000-0000-4000-8000-000000000001",
      now,
    );
    expect(sender.sendCode).not.toHaveBeenCalled();
    expect(sender.sendLink).not.toHaveBeenCalled();
  });
});
