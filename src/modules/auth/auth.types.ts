import { Field, InputType, ObjectType } from "@nestjs/graphql";
import { Request } from "express";
import { registerEnumType } from "@nestjs/graphql";
import { UserRole, type UserRoleValue } from "src/auth/role";

export const JWT_ISSUER = "dadamjang";
export const JWT_ACCESS_AUDIENCE = "dadamjang-api";
export const JWT_REFRESH_AUDIENCE = "dadamjang-refresh";

export type AccessJwtPayload = { userId: string; role: UserRoleValue; tokenUse: "access" };
export type RefreshJwtPayload = {
  userId: string;
  role: UserRoleValue;
  deviceId: string;
  tokenUse: "refresh";
};
export type JwtPayload = AccessJwtPayload | RefreshJwtPayload;

const roles = new Set<string>(Object.values(UserRole));
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isIdentifier = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isRole = (value: unknown): value is UserRoleValue => typeof value === "string" && roles.has(value);

export const isAccessJwtPayload = (value: unknown): value is AccessJwtPayload =>
  isRecord(value) && value.tokenUse === "access" && isIdentifier(value.userId) && isRole(value.role);

export const isRefreshJwtPayload = (value: unknown): value is RefreshJwtPayload =>
  isRecord(value) &&
  value.tokenUse === "refresh" &&
  isIdentifier(value.userId) &&
  isIdentifier(value.deviceId) &&
  isRole(value.role);

export type AuthRequest = Request & {
  user: AccessJwtPayload;
  cookies: { access_token?: string; refresh_token?: string };
};
export type RefreshAuthRequest = Request & {
  user: RefreshJwtPayload;
  cookies: { refresh_token?: string };
  refreshToken: string;
};
export type KakaoProfile = { providerUserId: string; email?: string; emailVerified: boolean };
export type KakaoRawProfile = {
  id: string;
  _json?: {
    kakao_account?: {
      email?: string;
      is_email_valid?: boolean;
      is_email_verified?: boolean;
    };
  };
};
export type KakaoRequest = Request & {
  user: KakaoProfile;
  cookies: { kakao_oauth_flow?: string };
};

export enum AuthPortal {
  FO = "FO",
  PARTNER = "PARTNER",
  BO = "BO",
}

registerEnumType(AuthPortal, { name: "AuthPortal" });

@InputType()
export class SigninAuthInput {
  @Field()
  userid!: string;
  @Field()
  password!: string;
  @Field(() => AuthPortal, { defaultValue: AuthPortal.FO })
  portal!: AuthPortal;
}

@ObjectType()
export class TokenPayload {
  @Field()
  accessToken!: string;
  @Field()
  refreshToken!: string;
  @Field()
  role!: string;
}

@ObjectType()
export class AuthViewer {
  @Field()
  userId!: string;
  @Field()
  userid!: string;
  @Field()
  email!: string;
  @Field()
  role!: string;
  @Field()
  hasPassword!: boolean;
}
