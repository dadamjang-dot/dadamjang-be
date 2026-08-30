import { decryptEmailPayload, encryptEmailPayload } from "./email.outbox";

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
