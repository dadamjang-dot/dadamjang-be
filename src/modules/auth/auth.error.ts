export enum AuthErrorMessage {
  AuthRequired = "아이디 또는 비밀번호가 올바르지 않습니다.",
  DuplicateUser = "이미 사용 중인 이메일 또는 아이디입니다.",
  InvalidEmailVerificationToken = "이메일 인증이 유효하지 않습니다.",
  RefreshTokenExpUndefined = "Refresh token expiration is missing.",
  RefreshTokenUndefined = "Refresh token is missing.",
  RefreshTokenWrong = "Refresh token is invalid.",
  InvalidOauthState = "OAuth state is invalid.",
}
