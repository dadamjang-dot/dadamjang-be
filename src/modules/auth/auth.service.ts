import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService, JwtSignOptions } from "@nestjs/jwt";
import * as bcrypt from "bcrypt";
import { randomUUID, timingSafeEqual } from "crypto";
import { CustomConflictException, CustomUnauthorizedException } from "src/common/errors/custom-exceptions";
import { hashToken } from "src/common/security/token-hash";
import { AdmissionLimiter, type RequestOrigin } from "src/modules/admission/admission-limiter";
import { EmailService } from "src/modules/email/email.service";
import { User } from "src/modules/database/schema";
import { AuthErrorMessage } from "./auth.error";
import { AuthRepository, type RefreshTokenStore } from "./auth.repository";
import { AuthPortal, JWT_ACCESS_AUDIENCE, JWT_ISSUER, JWT_REFRESH_AUDIENCE, SigninAuthInput } from "./auth.types";
import { hasBuyerCapability, UserRole, type UserRoleValue } from "src/auth/role";

type JwtExpiration = Exclude<JwtSignOptions["expiresIn"], undefined>;

const invalidPasswordHash = "$2b$10$nmo8L8VvFVH2sB.e3T0hP.TQMDhHxk88WTtFBkDgnjAlnHDR4W/rW";

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
    private readonly admissionLimiter: AdmissionLimiter,
  ) {}
  signin = async (input: SigninAuthInput, deviceId: string, origin: RequestOrigin) => {
    const userid = this.emailService.normalizeUserid(input.userid);
    const limit = input.portal === AuthPortal.Fo ? 20 : 5;
    await this.admissionLimiter.assertAllowed(
      `AUTH_SIGNIN_${input.portal}`,
      [
        { scopeType: "signin-ip", value: origin.ip, limit, windowMs: 15 * 60_000 },
        { scopeType: "signin-account", value: userid, limit, windowMs: 15 * 60_000 },
        { scopeType: "signin-device", value: origin.deviceId ?? deviceId, limit, windowMs: 15 * 60_000 },
      ],
      AuthErrorMessage.AuthRequired,
    );
    const signinStartedAt = await this.repository.signinStartedAt();
    const user = await this.repository.findByUserid(userid);
    if (!user) {
      await bcrypt.compare(input.password, invalidPasswordHash);
      throw new CustomUnauthorizedException(AuthErrorMessage.AuthRequired);
    }
    return this.withSigninLock(user.userId, deviceId, async (store) => {
      if (!(await bcrypt.compare(input.password, user.password)))
        throw new CustomUnauthorizedException(AuthErrorMessage.AuthRequired);
      this.assertPortalRole((user as User & { role?: UserRoleValue }).role ?? UserRole.User, input.portal);
      return this.issueTokensForUser(user, deviceId, store, signinStartedAt);
    });
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
  withSigninLock = async <T>(userId: string, deviceId: string, action: (store: RefreshTokenStore) => Promise<T>) => {
    const result = await this.repository.withSigninLock(userId, deviceId, action);
    if (!result.acquired) throw new CustomConflictException(AuthErrorMessage.SessionChanged);
    return result.value;
  };
  signinStartedAt = () => this.repository.signinStartedAt();
  issueTokensForUser = async (user: User, deviceId: string, store?: RefreshTokenStore, signinStartedAt?: Date) => {
    const previous = await this.repository.findRefreshToken(user.userId, deviceId, store);
    const tokens = await this.createTokensForUser(user, deviceId);
    const saved = await this.repository.saveRefreshToken(
      {
        userId: user.userId,
        deviceId,
        ...(previous === undefined ? {} : { previousRefreshToken: previous.refreshToken }),
        ...(signinStartedAt === undefined ? {} : { signinStartedAt }),
        refreshToken: tokens.refreshTokenHash,
        refreshTokenExp: tokens.refreshTokenExp,
      },
      store,
    );
    if (!saved) throw new CustomConflictException(AuthErrorMessage.SessionChanged);
    return tokens.payload;
  };
  private createTokensForUser = async (user: User, deviceId: string) => {
    const role = (user as User & { role?: UserRoleValue }).role ?? UserRole.User;
    const accessToken = await this.jwtService.signAsync(
      { userId: user.userId, role, tokenUse: "access", jti: randomUUID() },
      {
        secret: this.configService.getOrThrow<string>("JWT_ACCESS_TOKEN_SECRET"),
        expiresIn: this.configService.getOrThrow<string>("JWT_ACCESS_TOKEN_EXP") as JwtExpiration,
        algorithm: "HS256",
        issuer: JWT_ISSUER,
        audience: JWT_ACCESS_AUDIENCE,
      },
    );
    const refreshToken = await this.jwtService.signAsync(
      { userId: user.userId, role, deviceId, tokenUse: "refresh", jti: randomUUID() },
      {
        secret: this.configService.getOrThrow<string>("JWT_REFRESH_TOKEN_SECRET"),
        expiresIn: this.configService.getOrThrow<string>("JWT_REFRESH_TOKEN_EXP") as JwtExpiration,
        algorithm: "HS256",
        issuer: JWT_ISSUER,
        audience: JWT_REFRESH_AUDIENCE,
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
      (portal === AuthPortal.Fo && hasBuyerCapability(role)) ||
      (portal === AuthPortal.Partner && role === UserRole.Partner) ||
      (portal === AuthPortal.Bo && role === UserRole.Admin);
    if (!allowed) throw new CustomUnauthorizedException(AuthErrorMessage.AuthRequired);
  };
}
