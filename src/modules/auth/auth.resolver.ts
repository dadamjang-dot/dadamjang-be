import { Args, Context, Mutation, Resolver } from "@nestjs/graphql";
import { UseGuards } from "@nestjs/common";
import { Request, Response } from "express";
import { JwtRefreshTokenGuard } from "src/guards/refreshToken.guard";
import { CustomUnauthorizedException } from "src/common/errors/custom-exceptions";
import { authCookieOptions } from "./cookie-options";
import { AuthErrorMessage } from "./auth.error";
import { AuthService } from "./auth.service";
import { KakaoSignupAuthInput, RefreshAuthRequest, SigninAuthInput, SignupAuthInput, TokenPayload } from "./auth.types";

const deviceIdFromRequest = (req: Request) => { const value = req.headers["x-device-id"]; const deviceId = (Array.isArray(value) ? value[0] : value)?.trim(); if (!deviceId) throw new CustomUnauthorizedException(AuthErrorMessage.AuthRequired); return deviceId; };
const setTokenCookies = (res: Response, tokenData: TokenPayload) => { res.setHeader("Authorization", `Bearer ${tokenData.accessToken}`); res.cookie("access_token", tokenData.accessToken, authCookieOptions); res.cookie("refresh_token", tokenData.refreshToken, authCookieOptions); };

@Resolver()
export class AuthResolver {
  constructor(private readonly authService: AuthService) {}
  @Mutation(() => TokenPayload) async signup(@Args("input") input: SignupAuthInput, @Context("req") req: Request, @Context("res") res: Response) { const result = await this.authService.signup(input, deviceIdFromRequest(req)); setTokenCookies(res, result); return result; }
  @Mutation(() => TokenPayload) async signin(@Args("input") input: SigninAuthInput, @Context("req") req: Request, @Context("res") res: Response) { const result = await this.authService.signin(input, deviceIdFromRequest(req)); setTokenCookies(res, result); return result; }
  @Mutation(() => TokenPayload) async completeKakaoSignup(@Args("input") input: KakaoSignupAuthInput, @Context("req") req: Request, @Context("res") res: Response) { const result = await this.authService.completeKakaoSignup(input, deviceIdFromRequest(req)); setTokenCookies(res, result); return result; }
  @UseGuards(JwtRefreshTokenGuard) @Mutation(() => TokenPayload) async refresh(@Context("req") req: RefreshAuthRequest, @Context("res") res: Response) { const result = await this.authService.refresh(req.user.userId, req.user.deviceId, req.cookies.refresh_token); setTokenCookies(res, result); return result; }
  @UseGuards(JwtRefreshTokenGuard) @Mutation(() => Boolean) async logout(@Context("req") req: RefreshAuthRequest, @Context("res") res: Response) { await this.authService.logout(req.user.userId, req.user.deviceId); res.clearCookie("access_token", authCookieOptions); res.clearCookie("refresh_token", authCookieOptions); return true; }
}
