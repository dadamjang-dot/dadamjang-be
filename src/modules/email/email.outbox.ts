import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as bcrypt from "bcrypt";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt } from "crypto";
import { EmailRepository } from "./email.repository";
import { EmailSender } from "./email.sender";
import { EmailDeliveryKind, EmailVerificationPurpose } from "./email.types";

const deliveryKey = (secret: string) => createHash("sha256").update("email-outbox\0").update(secret).digest();

export const encryptEmailPayload = (payload: string, secret: string) => {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deliveryKey(secret), nonce);
  const ciphertext = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
  return [nonce, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64url")).join(".");
};

export const decryptEmailPayload = (payload: string, secret: string) => {
  const parts = payload.split(".");
  if (parts.length !== 3) throw new Error("Invalid email outbox payload");
  const [nonceValue, tagValue, ciphertextValue] = parts;
  if (!nonceValue || !tagValue || !ciphertextValue) throw new Error("Invalid email outbox payload");
  const decipher = createDecipheriv("aes-256-gcm", deliveryKey(secret), Buffer.from(nonceValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextValue, "base64url")), decipher.final()]).toString("utf8");
};

export const emailCodeSecret = (email: string, code: string, purpose: string, pepper: string) =>
  `${email}:${code}:${purpose}:${pepper}`;

@Injectable()
export class EmailDeliveryWorker implements OnModuleInit, OnApplicationShutdown {
  private draining = false;
  private readonly logger = new Logger(EmailDeliveryWorker.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly repository: EmailRepository,
    private readonly configService: ConfigService,
    @Inject("EmailSender") private readonly sender: EmailSender,
  ) {}

  onModuleInit = () => {
    if (this.configService.get<string>("EMAIL_OUTBOX_WORKER_ENABLED") === "false") return;
    this.timer = setInterval(() => void this.drain(), 1_000);
    this.timer.unref();
    void this.drain();
  };

  onApplicationShutdown = () => {
    if (this.timer) clearInterval(this.timer);
  };

  runOnce = async (now = new Date()) => {
    const claimed = await this.repository.claimDelivery(now);
    if (!claimed) return false;
    try {
      const prepared = await this.prepare(claimed, now);
      if (!prepared) return true;
      const secret = decryptEmailPayload(
        prepared.payloadCiphertext,
        this.configService.getOrThrow<string>("EMAIL_CODE_PEPPER"),
      );
      if (!(await this.repository.isDeliveryCurrent(prepared, secret, now))) {
        await this.repository.suppressDelivery(prepared.id, prepared.claimToken, now);
        return true;
      }
      await this.send(prepared.id, prepared.kind, prepared.email, secret);
      await this.repository.completeDelivery(prepared.id, prepared.claimToken, now);
    } catch (error) {
      await this.repository.retryDelivery(claimed, error, now);
    }
    return true;
  };

  private drain = async () => {
    if (this.draining) return;
    this.draining = true;
    try {
      let handled = true;
      while (handled) handled = await this.runOnce();
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : "Email outbox delivery failed");
    } finally {
      this.draining = false;
    }
  };

  private prepare = async (claimed: NonNullable<Awaited<ReturnType<EmailRepository["claimDelivery"]>>>, now: Date) => {
    if (claimed.payloadCiphertext && claimed.proofId)
      return { ...claimed, payloadCiphertext: claimed.payloadCiphertext, proofId: claimed.proofId };
    if (claimed.kind === EmailDeliveryKind.AdminInvite) throw new Error("Admin invite payload is missing");
    const purpose =
      claimed.kind === EmailDeliveryKind.SignupCode
        ? EmailVerificationPurpose.Signup
        : EmailVerificationPurpose.PasswordReset;
    const secret =
      claimed.kind === EmailDeliveryKind.PasswordResetLink
        ? randomBytes(32).toString("base64url")
        : String(randomInt(1_000_000)).padStart(6, "0");
    const pepper = this.configService.getOrThrow<string>("EMAIL_CODE_PEPPER");
    const payloadCiphertext = encryptEmailPayload(secret, pepper);
    const proofExpiresAt = new Date(
      now.getTime() + (claimed.kind === EmailDeliveryKind.PasswordResetLink ? 15 : 5) * 60_000,
    );
    const codeHash =
      claimed.kind === EmailDeliveryKind.PasswordResetLink
        ? undefined
        : await bcrypt.hash(emailCodeSecret(claimed.email, secret, purpose, pepper), 10);
    return this.repository.prepareDelivery(
      claimed,
      {
        payloadCiphertext,
        proofExpiresAt,
        ...(codeHash ? { codeHash } : { token: secret }),
      },
      now,
    );
  };

  private send = async (id: string, kind: string, email: string, secret: string) => {
    const idempotencyKey = `email-delivery/${id}`;
    if (kind === EmailDeliveryKind.SignupCode || kind === EmailDeliveryKind.PasswordResetCode)
      return this.sender.sendCode(email, secret, idempotencyKey);
    if (kind === EmailDeliveryKind.PasswordResetLink) {
      const clientUrl = this.configService.getOrThrow<string>("CLIENT_URL").replace(/\/$/, "");
      return this.sender.sendLink(
        email,
        "비밀번호 재설정",
        `${clientUrl}/account-recovery/password#token=${secret}`,
        idempotencyKey,
      );
    }
    const boUrl = this.configService.getOrThrow<string>("DADAMJANG_BO_URL").replace(/\/$/, "");
    return this.sender.sendLink(email, "다담장 관리자 초대", `${boUrl}/invite/accept#token=${secret}`, idempotencyKey);
  };
}
