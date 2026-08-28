import { Field, InputType, ObjectType } from "@nestjs/graphql";
import { Request } from "express";
import { registerEnumType } from "@nestjs/graphql";
import type { UserRoleValue } from "src/auth/role";

export type JwtPayload = { userId: string; role: UserRoleValue; deviceId?: string };
export type AuthRequest = Request & {
  user: JwtPayload;
  cookies: { access_token?: string; refresh_token?: string };
};
export type RefreshAuthRequest = Request & {
  user: JwtPayload & { deviceId: string };
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
  Fo = "FO",
  Partner = "PARTNER",
  Bo = "BO",
}

registerEnumType(AuthPortal, { name: "AuthPortal" });

@InputType()
export class SigninAuthInput {
  @Field()
  userid!: string;
  @Field()
  password!: string;
  @Field(() => AuthPortal, { defaultValue: AuthPortal.Fo })
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
}
