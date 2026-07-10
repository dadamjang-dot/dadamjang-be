import {
  BadRequestException,
  HttpException,
  HttpStatus,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";

export class CustomUnauthorizedException extends UnauthorizedException {
  /**
   * 인증 실패 응답을 생성한다.
   *
   * @param message 응답 메시지
   */
  constructor(message: string) {
    super(message);
  }
}

export class CustomBadRequestException extends BadRequestException {
  /**
   * 잘못된 요청 응답을 생성한다.
   *
   * @param message 응답 메시지
   */
  constructor(message: string) {
    super(message);
  }
}

export class CustomNotFoundException extends NotFoundException {
  /**
   * 리소스 없음 응답을 생성한다.
   *
   * @param message 응답 메시지
   */
  constructor(message: string) {
    super(message);
  }
}

export class CustomTooManyRequestsException extends HttpException {
  /**
   * 요청 제한 초과 응답을 생성한다.
   *
   * @param message 응답 메시지
   */
  constructor(message: string) {
    super(message, HttpStatus.TOO_MANY_REQUESTS);
  }
}

export class CustomServiceUnavailableException extends HttpException {
  constructor(message: string) {
    super(message, HttpStatus.SERVICE_UNAVAILABLE);
  }
}
