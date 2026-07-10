import { ExecutionContext, Injectable } from "@nestjs/common";
import { GqlExecutionContext } from "@nestjs/graphql";
import { AuthGuard } from "@nestjs/passport";

@Injectable()
export class JwtAccessTokenGuard extends AuthGuard("access_token") {
  getRequest(context: ExecutionContext) {
    return GqlExecutionContext.create(context).getContext().req;
  }
}
