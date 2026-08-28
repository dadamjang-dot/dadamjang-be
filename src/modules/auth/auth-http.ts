import type { Request, Response } from "express";
import { CustomUnauthorizedException } from "src/common/errors/custom-exceptions";
import { AuthErrorMessage } from "./auth.error";
import { authCookieOptions } from "./cookie-options";
import type { TokenPayload } from "./auth.types";

export const deviceIdFromRequest = (req: Request) => {
  const value = req.headers["x-device-id"];
  const deviceId = (Array.isArray(value) ? value[0] : value)?.trim();
  if (!deviceId || deviceId.length > 255) throw new CustomUnauthorizedException(AuthErrorMessage.AuthRequired);
  return deviceId;
};

export const setTokenCookies = (res: Response, tokenData: TokenPayload) => {
  res.setHeader("Authorization", `Bearer ${tokenData.accessToken}`);
  res.cookie("access_token", tokenData.accessToken, authCookieOptions);
  res.cookie("refresh_token", tokenData.refreshToken, authCookieOptions);
};
