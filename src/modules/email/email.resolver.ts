import { Args, Context, Mutation, Resolver } from "@nestjs/graphql";
import { Request } from "express";
import { EmailService } from "./email.service";
import { EmailVerificationPayload, OkPayload, RequestEmailCodeInput, RequestPasswordResetInput, ResetPasswordInput, VerifyEmailCodeInput } from "./email.types";

@Resolver()
export class EmailResolver {
  constructor(private readonly emailService: EmailService) {}
  @Mutation(() => OkPayload) requestSignupEmailCode(@Args("input") input: RequestEmailCodeInput, @Context("req") req: Request) { return this.emailService.requestSignupCode(input.email, req.ip); }
  @Mutation(() => EmailVerificationPayload) verifySignupEmailCode(@Args("input") input: VerifyEmailCodeInput) { return this.emailService.verifySignupCode(input.email, input.code); }
  @Mutation(() => OkPayload) requestPasswordReset(@Args("input") input: RequestPasswordResetInput, @Context("req") req: Request) { return this.emailService.requestPasswordReset(input.email, req.ip); }
  @Mutation(() => OkPayload) resetPassword(@Args("input") input: ResetPasswordInput) { return this.emailService.resetPassword(input.token, input.password); }
}
