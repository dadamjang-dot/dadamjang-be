import { Field, GraphQLISODateTime, ID, InputType, ObjectType, registerEnumType } from "@nestjs/graphql";

export const IdentityVerificationPurpose = {
  SIGNUP: "SIGNUP",
  FIND_EMAIL: "FIND_EMAIL",
} as const;

export type IdentityVerificationPurposeValue =
  (typeof IdentityVerificationPurpose)[keyof typeof IdentityVerificationPurpose];

export const IdentityVerificationProvider = {
  TOSS: "TOSS",
  KAKAO: "KAKAO",
  NAVER: "NAVER",
} as const;

export type IdentityVerificationProviderValue =
  (typeof IdentityVerificationProvider)[keyof typeof IdentityVerificationProvider];

export const IdentityVerificationStatus = {
  PENDING: "PENDING",
  VERIFIED: "VERIFIED",
  FAILED: "FAILED",
  EXPIRED: "EXPIRED",
} as const;

export type IdentityVerificationStatusValue =
  (typeof IdentityVerificationStatus)[keyof typeof IdentityVerificationStatus];

registerEnumType(IdentityVerificationPurpose, { name: "IdentityVerificationPurpose" });
registerEnumType(IdentityVerificationProvider, { name: "IdentityVerificationProvider" });
registerEnumType(IdentityVerificationStatus, { name: "IdentityVerificationStatus" });

@InputType()
export class StartIdentityVerificationInput {
  @Field(() => IdentityVerificationPurpose)
  purpose!: IdentityVerificationPurposeValue;

  @Field(() => IdentityVerificationProvider)
  provider!: IdentityVerificationProviderValue;
}

@ObjectType()
export class IdentityVerificationStartPayload {
  @Field(() => ID)
  sessionId!: string;

  @Field()
  launchUrl!: string;

  @Field(() => GraphQLISODateTime)
  expiresAt!: Date;
}

@ObjectType()
export class IdentityVerificationStatusPayload {
  @Field(() => ID)
  sessionId!: string;

  @Field(() => IdentityVerificationStatus)
  status!: IdentityVerificationStatusValue;

  @Field(() => GraphQLISODateTime)
  expiresAt!: Date;
}

@ObjectType()
export class IdentityVerificationProofPayload {
  @Field()
  identityVerificationToken!: string;
}

export type InicisSessionRequest = {
  readonly sessionId: string;
  readonly merchantTransactionId: string;
  readonly provider: IdentityVerificationProviderValue;
};

export type InicisCallbackInput = {
  readonly resultCode: string;
  readonly authRequestUrl?: string;
  readonly transactionId?: string;
  readonly token?: string;
};

export type InicisVerifiedResult = {
  readonly ci: string;
  readonly birthday: string;
  readonly certificateProvider: string;
};
