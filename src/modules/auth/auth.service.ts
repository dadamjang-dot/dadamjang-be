import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService, JwtSignOptions } from "@nestjs/jwt";
import * as bcrypt from "bcrypt";
import { randomUUID, timingSafeEqual } from "crypto";
import { CustomUnauthorizedException } from "src/common/errors/custom-exceptions";
import { hashToken } from "src/common/security/token-hash";
import { EmailService } from "src/modules/email/email.service";
import { User } from "src/modules/database/schema";
import { AuthErrorMessage } from "./auth.error";
import { AuthRepository } from "./auth.repository";
import { AuthPortal, SigninAuthInput } from "./auth.types";
import { UserRole, type UserRoleValue } from "src/auth/role";

type JwtExpiration = Exclude<JwtSignOptions["expiresIn"], undefined>;

const matchesRefreshToken = async (token: string, saved: string) => {
  if (saved.startsWith("$2")) return bcrypt.compare(token, saved);
  const digest = hashToken(token);
  return saved.length === digest.length && timingSafeEqual(Buffer.from(saved), Buffer.from(digest));
};

@Injectable()
export class AuthService {
  constructor(
    private readonly repository: AuthRepository,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly emailService: EmailService,
  ) {}
  signin = async (input: SigninAuthInput, deviceId: string) => {
    const user = await this.repository.findByUserid(this.emailService.normalizeUserid(input.userid));
    if (!user || !(await bcrypt.compare(input.password, user.password)))
      throw new CustomUnauthorizedException(AuthErrorMessage.AuthRequired);
    this.assertPortalRole((user as User & { role?: UserRoleValue }).role ?? UserRole.User, input.portal);
    return this.issueTokensForUser(user, deviceId);
  };
  refresh = async (userId: string, deviceId: string, refreshToken: string) => {
    const saved = await this.repository.findRefreshToken(userId, deviceId);
    if (
      !saved ||
      saved.refreshTokenExp.getTime() <= Date.now() ||
      !(await matchesRefreshToken(refreshToken, saved.refreshToken))
    )
      throw new CustomUnauthorizedException(AuthErrorMessage.AuthRequired);
    const user = await this.repository.findUser(userId);
    if (!user) throw new CustomUnauthorizedException(AuthErrorMessage.AuthRequired);
    const tokens = await this.createTokensForUser(user, deviceId);
    const rotated = await this.repository.rotateRefreshToken({
      userId,
      deviceId,
      previousRefreshToken: saved.refreshToken,
      refreshToken: tokens.refreshTokenHash,
      refreshTokenExp: tokens.refreshTokenExp,
    });
    if (!rotated) throw new CustomUnauthorizedException(AuthErrorMessage.AuthRequired);
    return tokens.payload;
  };
  logout = async (userId: string, deviceId: string, refreshToken: string) => {
    const saved = await this.repository.findRefreshToken(userId, deviceId);
    if (
      !saved ||
      saved.refreshTokenExp.getTime() <= Date.now() ||
      !(await matchesRefreshToken(refreshToken, saved.refreshToken)) ||
      !(await this.repository.deleteRefreshToken(userId, deviceId, saved.refreshToken))
    )
      throw new CustomUnauthorizedException(AuthErrorMessage.AuthRequired);
    return true;
  };
  getViewer = async (userId: string) => this.repository.findUser(userId);
  issueTokensForUser = async (user: User, deviceId: string) => {
    const tokens = await this.createTokensForUser(user, deviceId);
    await this.repository.saveRefreshToken({
      userId: user.userId,
      deviceId,
      refreshToken: tokens.refreshTokenHash,
      refreshTokenExp: tokens.refreshTokenExp,
    });
    return tokens.payload;
  };
  private createTokensForUser = async (user: User, deviceId: string) => {
    const role = (user as User & { role?: UserRoleValue }).role ?? UserRole.User;
    const accessToken = await this.jwtService.signAsync(
      { userId: user.userId, role },
      {
        secret: this.configService.getOrThrow<string>("JWT_ACCESS_TOKEN_SECRET"),
        expiresIn: this.configService.getOrThrow<string>("JWT_ACCESS_TOKEN_EXP") as JwtExpiration,
      },
    );
    const refreshToken = await this.jwtService.signAsync(
      { userId: user.userId, role, deviceId, jti: randomUUID() },
      {
        secret: this.configService.getOrThrow<string>("JWT_REFRESH_TOKEN_SECRET"),
        expiresIn: this.configService.getOrThrow<string>("JWT_REFRESH_TOKEN_EXP") as JwtExpiration,
      },
    );
    const decoded = this.jwtService.decode(refreshToken) as { exp?: number } | null;
    if (!decoded?.exp) throw new CustomUnauthorizedException(AuthErrorMessage.RefreshTokenExpUndefined);
    return {
      payload: { accessToken, refreshToken, role },
      refreshTokenHash: hashToken(refreshToken),
      refreshTokenExp: new Date(decoded.exp * 1000),
    };
  };
  private assertPortalRole = (role: UserRoleValue, portal: AuthPortal) => {
    const allowed =
      (portal === AuthPortal.Fo && role === UserRole.User) ||
      (portal === AuthPortal.Partner && role === UserRole.Partner) ||
      (portal === AuthPortal.Bo && role === UserRole.Admin);
    if (!allowed) throw new CustomUnauthorizedException(AuthErrorMessage.AuthRequired);
  };
}
