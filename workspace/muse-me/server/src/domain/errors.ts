/** 领域异常族：API 层按 httpStatus 映射，不认具体类名之外的细节。 */

export class AppError extends Error {
  readonly httpStatus: number;

  constructor(message: string, httpStatus = 400) {
    super(message);
    this.name = new.target.name;
    this.httpStatus = httpStatus;
  }
}

export class NotFound extends AppError {
  constructor(message: string) {
    super(message, 404);
  }
}

export class ValidationFailed extends AppError {
  constructor(message: string) {
    super(message, 400);
  }
}

export class PermissionDenied extends AppError {
  constructor(message: string) {
    super(message, 403);
  }
}

export class GuardrailDenied extends AppError {
  constructor(message: string) {
    super(message, 403);
  }
}

export class InvalidTransition extends AppError {
  constructor(message: string) {
    super(message, 409);
  }
}

export class RuntimeNotConfigured extends AppError {
  constructor(message: string) {
    super(message, 503);
  }
}
