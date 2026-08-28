import { Args, Context, Mutation, Resolver } from "@nestjs/graphql";
import { Request } from "express";
import { requestOriginFromRequest } from "src/modules/admission/admission-limiter";
import { EmailService } from "./email.service";
import {
  EmailVerificationPayload,
  OkPayload,
  RequestEmailCodeInput,
  RequestPasswordResetInput,
  ResetPasswordInput,
  VerifyEmailCodeInput,
} from "./email.types";

@Resolver()
export class EmailResolver {
  constructor(private readonly emailService: EmailService) {}
  @Mutation(() => OkPayload) requestSignupEmailCode(
    @Args("input") input: RequestEmailCodeInput,
    @Context("req") req: Request,
  ) {
    return this.emailService.requestSignupCode(input.email, requestOriginFromRequest(req));
  }
  @Mutation(() => EmailVerificationPayload) verifySignupEmailCode(
    @Args("input") input: VerifyEmailCodeInput,
    @Context("req") req: Request,
  ) {
    return this.emailService.verifySignupCode(input.email, input.code, requestOriginFromRequest(req));
  }
  @Mutation(() => OkPayload) requestPasswordResetCode(
    @Args("input") input: RequestEmailCodeInput,
    @Context("req") req: Request,
  ) {
    return this.emailService.requestPasswordResetCode(input.email, requestOriginFromRequest(req));
  }
  @Mutation(() => EmailVerificationPayload) verifyPasswordResetCode(
    @Args("input") input: VerifyEmailCodeInput,
    @Context("req") req: Request,
  ) {
    return this.emailService.verifyPasswordResetCode(input.email, input.code, requestOriginFromRequest(req));
  }
  @Mutation(() => OkPayload) requestPasswordReset(
    @Args("input") input: RequestPasswordResetInput,
    @Context("req") req: Request,
  ) {
    return this.emailService.requestPasswordReset(input.email, requestOriginFromRequest(req));
  }
  @Mutation(() => OkPayload) resetPassword(@Args("input") input: ResetPasswordInput, @Context("req") req: Request) {
    return this.emailService.resetPassword(input.token, input.password, requestOriginFromRequest(req));
  }
}
