import { Injectable } from "@nestjs/common";
import type { JwtPayload } from "src/modules/auth/auth.types";
import { JwtAccessTokenGuard } from "./access-token.guard";

@Injectable()
export class OptionalJwtAccessTokenGuard extends JwtAccessTokenGuard {
  handleRequest<TUser = JwtPayload>(_error: unknown, user: TUser | undefined) {
    return user;
  }
}
