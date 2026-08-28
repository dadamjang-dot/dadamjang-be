import { Args, Context, ID, Mutation, Query, Resolver } from "@nestjs/graphql";
import type { Request } from "express";
import { deviceIdFromRequest } from "src/modules/auth/auth-http";
import { IdentityVerificationService } from "./identity-verification.service";
import {
  IdentityVerificationProofPayload,
  IdentityVerificationStartPayload,
  IdentityVerificationStatusPayload,
  StartIdentityVerificationInput,
} from "./identity-verification.types";

@Resolver()
export class IdentityVerificationResolver {
  constructor(private readonly service: IdentityVerificationService) {}

  @Mutation(() => IdentityVerificationStartPayload)
  startIdentityVerification(@Args("input") input: StartIdentityVerificationInput, @Context("req") req: Request) {
    return this.service.start(input, deviceIdFromRequest(req));
  }

  @Query(() => IdentityVerificationStatusPayload)
  identityVerificationStatus(@Args("sessionId", { type: () => ID }) sessionId: string, @Context("req") req: Request) {
    return this.service.status(sessionId, deviceIdFromRequest(req));
  }

  @Mutation(() => IdentityVerificationProofPayload)
  completeIdentityVerification(
    @Args("sessionId", { type: () => ID }) sessionId: string,
    @Args("callbackToken") callbackToken: string,
    @Context("req") req: Request,
  ) {
    return this.service.complete(sessionId, deviceIdFromRequest(req), callbackToken);
  }
}
