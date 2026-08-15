import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";

export class CustomUnauthorizedException extends UnauthorizedException {
  constructor(message: string) {
    super(message);
  }
}

export class CustomBadRequestException extends BadRequestException {
  constructor(message: string) {
    super(message);
  }
}

export class CustomNotFoundException extends NotFoundException {
  constructor(message: string) {
    super(message);
  }
}

export class CustomForbiddenException extends ForbiddenException {
  constructor(message: string) {
    super(message);
  }
}

export class CustomTooManyRequestsException extends HttpException {
  constructor(message: string) {
    super(message, HttpStatus.TOO_MANY_REQUESTS);
  }
}

export class CustomServiceUnavailableException extends HttpException {
  constructor(message: string) {
    super(message, HttpStatus.SERVICE_UNAVAILABLE);
  }
}

export class CustomConflictException extends HttpException {
  constructor(message: string) {
    super(message, HttpStatus.CONFLICT);
  }
}
