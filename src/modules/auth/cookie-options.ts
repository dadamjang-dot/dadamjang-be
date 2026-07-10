import { CookieOptions } from "express";

const sameSite = (): CookieOptions["sameSite"] => {
  const value = process.env.AUTH_COOKIE_SAMESITE;
  if (value === "strict" || value === "lax" || value === "none") return value;
  return "lax";
};

export const authCookieOptions: CookieOptions = {
  httpOnly: true,
  sameSite: sameSite(),
  secure: process.env.NODE_ENV === "production",
  domain: process.env.AUTH_COOKIE_DOMAIN || undefined,
  path: "/",
};
