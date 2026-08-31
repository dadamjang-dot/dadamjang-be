import { Injectable } from "@nestjs/common";
import { randomBytes } from "crypto";
import { hashToken } from "src/common/security/token-hash";
import { FoAccountRepository } from "./fo-account.repository";

@Injectable()
export class FoAccountService {
  constructor(private readonly repository: FoAccountRepository) {}

  createReactivationToken = async (userId: string, deviceId: string) => {
    const reactivationToken = randomBytes(32).toString("base64url");
    await this.repository.insertReactivationToken({
      tokenHash: hashToken(reactivationToken),
      userId,
      deviceIdHash: hashToken(deviceId),
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });
    return reactivationToken;
  };
}
