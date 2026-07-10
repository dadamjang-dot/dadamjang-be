import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService, JwtSignOptions } from "@nestjs/jwt";
import * as bcrypt from "bcrypt";
import { randomBytes, randomUUID } from "crypto";
import { CustomBadRequestException, CustomUnauthorizedException } from "src/common/errors/custom-exceptions";
import { EmailService } from "src/modules/email/email.service";
import { User } from "src/modules/database/schema";
import { AuthErrorMessage } from "./auth.error";
import { AuthRepository } from "./auth.repository";
import { KakaoProfile, KakaoSignupAuthInput, SigninAuthInput, SignupAuthInput } from "./auth.types";

@Injectable()
export class AuthService {
  constructor(private readonly repository: AuthRepository, private readonly jwtService: JwtService, private readonly configService: ConfigService, private readonly emailService: EmailService) {}
  signup = async (input: SignupAuthInput, deviceId: string) => {
    const user = await this.mapDuplicate(async () => this.emailService.consumeSignupToken(input.emailVerificationToken, input.email, { userId: randomUUID(), userid: input.userid, password: await bcrypt.hash(input.password, 10) }));
    if (!user) throw new CustomUnauthorizedException(AuthErrorMessage.InvalidEmailVerificationToken);
    return this.issueTokens(user, deviceId);
  };
  signin = async (input: SigninAuthInput, deviceId: string) => { const user = await this.repository.findByUserid(this.emailService.normalizeUserid(input.userid)); if (!user || !(await bcrypt.compare(input.password, user.password))) throw new CustomUnauthorizedException(AuthErrorMessage.AuthRequired); return this.issueTokens(user, deviceId); };
  beginKakao = async (profile: KakaoProfile, deviceId: string) => { const user = await this.repository.findKakaoUser(profile.providerUserId); if (user) return { existingUser: true, tokenPayload: await this.issueTokens(user, deviceId) }; if (!profile.email) throw new CustomBadRequestException("카카오 계정 이메일 제공 동의가 필요합니다."); const kakaoSignupToken = randomBytes(32).toString("base64url"); await this.repository.createKakaoSignupToken(kakaoSignupToken, profile.providerUserId, this.emailService.normalizeEmail(profile.email)); return { existingUser: false, kakaoSignupToken }; };
  completeKakaoSignup = async (input: KakaoSignupAuthInput, deviceId: string) => { const user = await this.mapDuplicate(async () => this.repository.consumeKakaoSignupTokenAndCreateUser(input.kakaoSignupToken, { userId: randomUUID(), userid: this.emailService.normalizeUserid(input.userid), password: await bcrypt.hash(randomBytes(32).toString("base64url"), 10) })); if (!user) throw new CustomUnauthorizedException("카카오 가입 토큰이 유효하지 않습니다."); return this.issueTokens(user, deviceId); };
  refresh = async (userId: string, deviceId: string, refreshToken: string) => { const saved = await this.repository.findRefreshToken(userId, deviceId); if (!saved || saved.refreshTokenExp.getTime() <= Date.now() || !(await bcrypt.compare(refreshToken, saved.refreshToken))) throw new CustomUnauthorizedException(AuthErrorMessage.AuthRequired); const user = await this.repository.findUser(userId); if (!user) throw new CustomUnauthorizedException(AuthErrorMessage.AuthRequired); return this.issueTokens(user, deviceId); };
  logout = async (userId: string, deviceId: string) => { await this.repository.deleteRefreshToken(userId, deviceId); return true; };
  compareUserRefreshToken = async (userId: string, deviceId: string, token: string) => { const saved = await this.repository.findRefreshToken(userId, deviceId); return !!saved && saved.refreshTokenExp.getTime() > Date.now() && bcrypt.compare(token, saved.refreshToken); };
  private issueTokens = async (user: User, deviceId: string) => { const accessToken = await this.jwtService.signAsync({ userId: user.userId }, { secret: this.configService.getOrThrow<string>("JWT_ACCESS_TOKEN_SECRET"), expiresIn: this.configService.getOrThrow<string>("JWT_ACCESS_TOKEN_EXP") as JwtSignOptions["expiresIn"] }); const refreshToken = await this.jwtService.signAsync({ userId: user.userId, deviceId }, { secret: this.configService.getOrThrow<string>("JWT_REFRESH_TOKEN_SECRET"), expiresIn: this.configService.getOrThrow<string>("JWT_REFRESH_TOKEN_EXP") as JwtSignOptions["expiresIn"] }); const decoded = this.jwtService.decode(refreshToken) as { exp?: number } | null; if (!decoded?.exp) throw new CustomUnauthorizedException(AuthErrorMessage.RefreshTokenExpUndefined); await this.repository.saveRefreshToken({ userId: user.userId, deviceId, refreshToken: await bcrypt.hash(refreshToken, 10), refreshTokenExp: new Date(decoded.exp * 1000) }); return { accessToken, refreshToken }; };
  private mapDuplicate = async <T>(operation: () => Promise<T>) => { try { return await operation(); } catch (error) { if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") throw new CustomBadRequestException(AuthErrorMessage.DuplicateUser); throw error; } };
}
