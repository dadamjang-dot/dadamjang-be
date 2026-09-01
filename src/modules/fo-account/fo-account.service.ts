import { Injectable } from "@nestjs/common";
import { randomBytes } from "crypto";
import { hashToken } from "src/common/security/token-hash";
import { AuthService } from "src/modules/auth/auth.service";
import type { TokenPayload } from "src/modules/auth/auth.types";
import type { DatabaseTransaction } from "src/modules/database/database.module";
import type { FoAccountDeactivationPayload } from "./fo-account.types";
import { FoAccountRepository } from "./fo-account.repository";

@Injectable()
export class FoAccountService {
  constructor(
    private readonly repository: FoAccountRepository,
    private readonly authService: AuthService,
  ) {}

  deactivate = (userId: string): Promise<FoAccountDeactivationPayload> => this.repository.deactivate(userId);

  createReactivationToken = async (userId: string, deviceId: string, store?: DatabaseTransaction): Promise<string> => {
    const reactivationToken = randomBytes(32).toString("base64url");
    await this.repository.insertReactivationToken(userId, hashToken(reactivationToken), hashToken(deviceId), store);
    return reactivationToken;
  };

  reactivate = (reactivationToken: string, deviceId: string): Promise<TokenPayload> =>
    this.repository.reactivate(hashToken(reactivationToken), hashToken(deviceId), (user, store) =>
      this.authService.issueTokensForUser(user, deviceId, store),
    );
}
