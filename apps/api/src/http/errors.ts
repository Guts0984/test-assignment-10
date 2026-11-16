import { HttpException } from '@nestjs/common';
import { type ErrorCode } from '@shop/shared';

/** An error that maps 1:1 to the public error format { error: { code, message, details } }. */
export class AppError extends HttpException {
  constructor(
    status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
    readonly headers?: Record<string, string>,
  ) {
    super({ code, message, details }, status);
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'validation_error', message, details);
export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'Not allowed') => new AppError(403, 'forbidden', message);
export const notFound = (message = 'Not found') => new AppError(404, 'not_found', message);
export const conflict = (code: ErrorCode, message: string, details?: unknown) =>
  new AppError(409, code, message, details);
export const unprocessable = (code: ErrorCode, message: string, details?: unknown) =>
  new AppError(422, code, message, details);
export const tooManyRequests = (retryAfterSec: number) =>
  new AppError(
    429,
    'rate_limited',
    'Too many requests, slow down',
    { retryAfterSec },
    {
      'Retry-After': String(Math.max(1, Math.ceil(retryAfterSec))),
    },
  );

const STATUS_CODES: Record<number, ErrorCode> = {
  400: 'validation_error',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'validation_error',
  422: 'validation_error',
  429: 'rate_limited',
  503: 'service_unavailable',
};

export function codeForStatus(status: number): ErrorCode {
  return STATUS_CODES[status] ?? (status >= 500 ? 'internal_error' : 'validation_error');
}
