import { Field, InputType, ObjectType } from "@nestjs/graphql";

export const EmailVerificationPurpose = {
  Signup: "SIGNUP",
  PasswordReset: "PASSWORD_RESET",
} as const;

export type EmailVerificationPurposeValue = (typeof EmailVerificationPurpose)[keyof typeof EmailVerificationPurpose];

export const EmailDeliveryKind = {
  SignupCode: "SIGNUP_CODE",
  PasswordResetCode: "PASSWORD_RESET_CODE",
  PasswordResetLink: "PASSWORD_RESET_LINK",
  AdminInvite: "ADMIN_INVITE",
} as const;

export type EmailDeliveryKindValue = (typeof EmailDeliveryKind)[keyof typeof EmailDeliveryKind];

@InputType()
export class RequestEmailCodeInput {
  @Field() email!: string;
}
@InputType()
export class VerifyEmailCodeInput {
  @Field() email!: string;
  @Field() code!: string;
}
@InputType()
export class RequestPasswordResetInput {
  @Field() email!: string;
}
@InputType()
export class ResetPasswordInput {
  @Field() token!: string;
  @Field() password!: string;
}

@ObjectType()
export class OkPayload {
  @Field() ok!: boolean;
}
@ObjectType()
export class EmailVerificationPayload {
  @Field() emailVerificationToken!: string;
}
