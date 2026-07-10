import { Field, InputType, ObjectType } from "@nestjs/graphql";

@InputType()
export class RequestEmailCodeInput { @Field() email!: string; }
@InputType()
export class VerifyEmailCodeInput { @Field() email!: string; @Field() code!: string; }
@InputType()
export class RequestPasswordResetInput { @Field() email!: string; }
@InputType()
export class ResetPasswordInput { @Field() token!: string; @Field() password!: string; }

@ObjectType()
export class OkPayload { @Field() ok!: boolean; }
@ObjectType()
export class EmailVerificationPayload { @Field() emailVerificationToken!: string; }
