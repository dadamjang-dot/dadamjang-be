export enum EmailErrorMessage {
  InvalidEmail = "유효한 이메일 주소를 입력해주세요.",
  InvalidCode = "인증번호가 올바르지 않습니다.",
  ExpiredCode = "인증번호가 만료되었습니다.",
  CodeRetryTooSoon = "인증번호 재요청은 60초 후 가능합니다.",
  RequestLimitExceeded = "요청 횟수를 초과했습니다.",
  CodeAttemptLimitExceeded = "인증 실패 횟수를 초과했습니다.",
  EmailSendFailed = "이메일 발송에 실패했습니다.",
  InvalidSignupToken = "이메일 인증이 유효하지 않습니다.",
  InvalidRecoveryToken = "복구 링크가 유효하지 않습니다.",
  InvalidPassword = "비밀번호는 8자 이상이어야 합니다.",
}
