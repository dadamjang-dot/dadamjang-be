import { SetMetadata } from "@nestjs/common";
import type { UserRoleValue } from "./role";

export const ROLES_KEY = "dadamjang:roles";
export const Roles = (...roles: UserRoleValue[]) => SetMetadata(ROLES_KEY, roles);
