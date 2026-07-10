import { Field, InputType, ObjectType } from "@nestjs/graphql";
import { Request } from "express";

export type JwtPayload = { userId: string; deviceId?: string };
export type AuthRequest = Request & { user: JwtPayload; cookies: { access_token?: string; refresh_token?: string } };
export type RefreshAuthRequest = Request & { user: JwtPayload & { deviceId: string }; cookies: { refresh_token: string } };
export type KakaoProfile = { providerUserId: string; email?: string };
export type KakaoRawProfile = { id: string; _json?: { kakao_account?: { email?: string } } };
export type KakaoRequest = Request & { user: KakaoProfile };

@InputType()
export class SignupAuthInput {
  @Field()
  userid!: string;
  @Field()
  email!: string;
  @Field()
  password!: string;
  @Field()
  emailVerificationToken!: string;
}

@InputType()
export class KakaoSignupAuthInput {
  @Field()
  userid!: string;
  @Field()
  kakaoSignupToken!: string;
}

@InputType()
export class SigninAuthInput {
  @Field()
  userid!: string;
  @Field()
  password!: string;
}

@ObjectType()
export class TokenPayload {
  @Field()
  accessToken!: string;
  @Field()
  refreshToken!: string;
}
