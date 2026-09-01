import type { Request, Response } from "express";
import { CustomBadRequestException, CustomUnauthorizedException } from "src/common/errors/custom-exceptions";
import { AuthErrorMessage } from "./auth.error";
import { authCookieOptions } from "./cookie-options";
import type { TokenPayload } from "./auth.types";

export const deviceIdFromRequest = (req: Request) => {
  const value = req.headers["x-device-id"];
  const deviceId = (Array.isArray(value) ? value[0] : value)?.trim();
  if (!deviceId) throw new CustomUnauthorizedException(AuthErrorMessage.AuthRequired);
  if (deviceId.length > 255) throw new CustomBadRequestException("Device identifier is too long.");
  return deviceId;
};

export const setTokenCookies = (res: Response, tokenData: TokenPayload) => {
  res.setHeader("Authorization", `Bearer ${tokenData.accessToken}`);
  res.cookie("access_token", tokenData.accessToken, authCookieOptions);
  res.cookie("refresh_token", tokenData.refreshToken, authCookieOptions);
};

export const clearTokenCookies = (res: Response) => {
  res.clearCookie("access_token", authCookieOptions);
  res.clearCookie("refresh_token", authCookieOptions);
};
