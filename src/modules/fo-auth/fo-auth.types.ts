import { Field, GraphQLISODateTime, ID, InputType, ObjectType, registerEnumType } from "@nestjs/graphql";
import { TokenPayload } from "src/modules/auth/auth.types";

export const SignupConsentType = {
  AGE_OVER_14: "AGE_OVER_14",
  SERVICE_TERMS: "SERVICE_TERMS",
  PRIVACY_COLLECTION: "PRIVACY_COLLECTION",
  MARKETING: "MARKETING",
} as const;

export type SignupConsentTypeValue = (typeof SignupConsentType)[keyof typeof SignupConsentType];

registerEnumType(SignupConsentType, { name: "SignupConsentType" });

@ObjectType()
export class SignupConsentDocument {
  @Field(() => ID)
  documentId!: string;

  @Field(() => SignupConsentType)
  type!: SignupConsentTypeValue;

  @Field()
  title!: string;

  @Field()
  body!: string;

  @Field()
  version!: string;

  @Field()
  required!: boolean;

  @Field(() => GraphQLISODateTime)
  activeFrom!: Date;
}

@InputType()
export class ConsentAcceptanceInput {
  @Field(() => ID)
  documentId!: string;

  @Field()
  agreed!: boolean;
}

@InputType()
export class SigninFoInput {
  @Field()
  email!: string;

  @Field()
  password!: string;
}

@InputType()
export class SignupFoInput {
  @Field()
  email!: string;

  @Field()
  password!: string;

  @Field()
  emailVerificationToken!: string;

  @Field()
  identityVerificationToken!: string;

  @Field(() => [ConsentAcceptanceInput])
  consents!: ConsentAcceptanceInput[];
}

@ObjectType()
export class FindFoEmailPayload {
  @Field()
  found!: boolean;

  @Field({ nullable: true })
  maskedEmail?: string;
}

@ObjectType()
export class MarketingConsentPayload {
  @Field()
  agreed!: boolean;

  @Field(() => GraphQLISODateTime, { nullable: true })
  agreedAt?: Date;
}

export const KakaoLoginStatus = {
  SIGNED_IN: "SIGNED_IN",
  SIGNUP_REQUIRED: "SIGNUP_REQUIRED",
} as const;

export type KakaoLoginStatusValue = (typeof KakaoLoginStatus)[keyof typeof KakaoLoginStatus];

registerEnumType(KakaoLoginStatus, { name: "KakaoLoginStatus" });

@ObjectType()
export class KakaoLoginStartPayload {
  @Field(() => ID)
  flowId!: string;

  @Field()
  authUrl!: string;

  @Field(() => GraphQLISODateTime)
  expiresAt!: Date;
}

@InputType()
export class CompleteKakaoLoginInput {
  @Field(() => ID)
  flowId!: string;
}

@ObjectType()
export class KakaoLoginResult {
  @Field(() => KakaoLoginStatus)
  status!: KakaoLoginStatusValue;

  @Field(() => TokenPayload, { nullable: true })
  tokenPayload?: TokenPayload;

  @Field({ nullable: true })
  kakaoSignupToken?: string;

  @Field({ nullable: true })
  email?: string;

  @Field()
  emailVerificationRequired!: boolean;
}

@InputType()
export class CompleteKakaoSignupFoInput {
  @Field()
  kakaoSignupToken!: string;

  @Field({ nullable: true })
  email?: string;

  @Field({ nullable: true })
  emailVerificationToken?: string;

  @Field()
  identityVerificationToken!: string;

  @Field(() => [ConsentAcceptanceInput])
  consents!: ConsentAcceptanceInput[];
}
