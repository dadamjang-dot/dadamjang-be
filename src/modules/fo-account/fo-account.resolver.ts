import { UseGuards } from "@nestjs/common";
import { Args, Context, Mutation, Resolver } from "@nestjs/graphql";
import type { Request, Response } from "express";
import { JwtAccessTokenGuard } from "src/guards/access-token.guard";
import { clearTokenCookies, deviceIdFromRequest, setTokenCookies } from "src/modules/auth/auth-http";
import { AuthRequest, TokenPayload } from "src/modules/auth/auth.types";
import { FoAccountService } from "./fo-account.service";
import { FoAccountDeactivationPayload } from "./fo-account.types";

@Resolver()
export class FoAccountResolver {
  constructor(private readonly service: FoAccountService) {}

  @UseGuards(JwtAccessTokenGuard)
  @Mutation(() => FoAccountDeactivationPayload)
  async deactivateFoAccount(@Context("req") req: AuthRequest, @Context("res") res: Response) {
    const result = await this.service.deactivate(req.user.userId);
    clearTokenCookies(res);
    return result;
  }

  @Mutation(() => TokenPayload)
  async reactivateFoAccount(
    @Args("reactivationToken") reactivationToken: string,
    @Context("req") req: Request,
    @Context("res") res: Response,
  ) {
    const result = await this.service.reactivate(reactivationToken, deviceIdFromRequest(req));
    setTokenCookies(res, result);
    return result;
  }
}
