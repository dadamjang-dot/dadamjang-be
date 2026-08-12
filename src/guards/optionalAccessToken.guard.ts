import { Injectable } from "@nestjs/common";
import type { JwtPayload } from "src/modules/auth/auth.types";
import { JwtAccessTokenGuard } from "./accessToken.guard";

@Injectable()
export class OptionalJwtAccessTokenGuard extends JwtAccessTokenGuard {
  handleRequest<TUser = JwtPayload>(err: unknown, user: TUser | undefined): TUser {
    return err || !user ? user! : user;
  }
}
