export enum AuthErrorMessage {
  AuthRequired = "아이디 또는 비밀번호가 올바르지 않습니다.",
  RefreshTokenExpUndefined = "Refresh token expiration is missing.",
  RefreshTokenUndefined = "Refresh token is missing.",
  RefreshTokenWrong = "Refresh token is invalid.",
  InvalidOauthState = "OAuth state is invalid.",
  SessionChanged = "인증 세션이 변경되었습니다. 다시 시도해주세요.",
}
