import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { GqlExecutionContext } from "@nestjs/graphql";
import { Reflector } from "@nestjs/core";
import { CustomUnauthorizedException } from "src/common/errors/custom-exceptions";
import { ROLES_KEY } from "src/auth/roles.decorator";
import type { UserRoleValue } from "src/auth/role";
import type { AuthRequest } from "src/modules/auth/auth.types";

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate = (context: ExecutionContext): boolean => {
    const roles = this.reflector.getAllAndOverride<UserRoleValue[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!roles?.length) return true;

    const request = GqlExecutionContext.create(context).getContext<{ req: AuthRequest }>().req;
    if (!request.user?.role || !roles.includes(request.user.role)) {
      throw new CustomUnauthorizedException("접근 권한이 없습니다.");
    }

    return true;
  };
}
