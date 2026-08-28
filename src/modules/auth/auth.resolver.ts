import { Args, Context, Mutation, Query, Resolver } from "@nestjs/graphql";
import { UseGuards } from "@nestjs/common";
import { Request, Response } from "express";
import { JwtRefreshTokenGuard } from "src/guards/refresh-token.guard";
import { CustomUnauthorizedException } from "src/common/errors/custom-exceptions";
import { authCookieOptions } from "./cookie-options";
import { AuthErrorMessage } from "./auth.error";
import { deviceIdFromRequest, setTokenCookies } from "./auth-http";
import { AuthService } from "./auth.service";
import { AuthRequest, AuthViewer, RefreshAuthRequest, SigninAuthInput, TokenPayload } from "./auth.types";
import { JwtAccessTokenGuard } from "src/guards/access-token.guard";

@Resolver()
export class AuthResolver {
  constructor(private readonly authService: AuthService) {}
  @Mutation(() => TokenPayload) async signin(
    @Args("input") input: SigninAuthInput,
    @Context("req") req: Request,
    @Context("res") res: Response,
  ) {
    const result = await this.authService.signin(input, deviceIdFromRequest(req));
    setTokenCookies(res, result);
    return result;
  }
  @UseGuards(JwtRefreshTokenGuard)
  @Mutation(() => TokenPayload)
  async refresh(@Context("req") req: RefreshAuthRequest, @Context("res") res: Response) {
    const result = await this.authService.refresh(req.user.userId, req.user.deviceId, req.refreshToken);
    setTokenCookies(res, result);
    return result;
  }
  @UseGuards(JwtRefreshTokenGuard) @Mutation(() => Boolean) async logout(
    @Context("req") req: RefreshAuthRequest,
    @Context("res") res: Response,
  ) {
    await this.authService.logout(req.user.userId, req.user.deviceId);
    res.clearCookie("access_token", authCookieOptions);
    res.clearCookie("refresh_token", authCookieOptions);
    return true;
  }
  @UseGuards(JwtAccessTokenGuard) @Query(() => AuthViewer) async me(@Context("req") req: AuthRequest) {
    const user = await this.authService.getViewer(req.user.userId);
    if (!user) throw new CustomUnauthorizedException(AuthErrorMessage.AuthRequired);
    return user;
  }
}
