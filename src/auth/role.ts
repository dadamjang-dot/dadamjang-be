export const UserRole = {
  User: "USER",
  Partner: "PARTNER",
  Admin: "ADMIN",
} as const;

export type UserRoleValue = (typeof UserRole)[keyof typeof UserRole];

export const hasBuyerCapability = (role: string) => role === UserRole.User || role === UserRole.Partner;
