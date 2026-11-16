import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { type Request, type Response } from 'express';
import { ZodError } from 'zod';
import { AppError, codeForStatus } from './errors';

type ErrorLike = { status?: unknown; statusCode?: unknown; type?: unknown; message?: unknown };

/**
 * PostgreSQL "data exception" errors (class 22) that only a bad client value can cause: a safety
 * net behind the validation, so a value nobody thought of is a 400 and not a 500.
 *   22001 string too long   22003 number out of range   22007/22008 bad date or time
 *   22021 bad byte sequence (NUL)   22P02 bad text representation   22P05 untranslatable character
 */
const CLIENT_CAUSED_PG_CODES = new Set([
  '22001',
  '22003',
  '22007',
  '22008',
  '22021',
  '22P02',
  '22P05',
]);

const UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  '57P01',
  '57P02',
  '57P03', // admin shutdown, crash shutdown, cannot connect now (starting up)
  '08000',
  '08001',
  '08003',
  '08004',
  '08006', // connection exceptions
]);
const UNAVAILABLE_MESSAGE =
  /connection terminated|timeout exceeded when trying to connect|connection error|database system is (?:starting up|shutting down)|cannot use a pool after calling end|ECONNREFUSED/i;

/**
 * The database cannot be reached (down, restarting, pool exhausted): that is "try again in a moment"
 * (503 + Retry-After), not "the server is broken" (500) - clients, load balancers and the UI treat
 * the two very differently.
 */
export function isDatabaseUnavailable(e: unknown): boolean {
  for (let cur: unknown = e, i = 0; cur && typeof cur === 'object' && i < 5; i++) {
    const { code, message } = cur as { code?: unknown; message?: unknown };
    if (typeof code === 'string' && UNAVAILABLE_CODES.has(code)) return true;
    if (typeof message === 'string' && UNAVAILABLE_MESSAGE.test(message)) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

export function pgErrorCode(e: unknown): string | undefined {
  for (let cur: unknown = e, i = 0; cur && typeof cur === 'object' && i < 4; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * One error format for the whole API: { error: { code, message, details?, requestId } }.
 * Anything unexpected becomes a generic 500 WITHOUT leaking internals; anything caused by the
 * client (bad JSON, too large, validation, ...) stays a 4xx.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request & { requestId?: string }>();
    const requestId = req.requestId;

    let status = 500;
    let code = codeForStatus(500);
    let message = 'Internal server error';
    let details: unknown;
    let headers: Record<string, string> | undefined;

    if (exception instanceof AppError) {
      status = exception.getStatus();
      code = exception.code;
      message = exception.message;
      details = exception.details;
      headers = exception.headers;
    } else if (exception instanceof ZodError) {
      status = 400;
      code = 'validation_error';
      message = 'Invalid request';
      details = exception.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = codeForStatus(status);
      message = status >= 500 ? 'Internal server error' : exception.message;
    } else if (CLIENT_CAUSED_PG_CODES.has(pgErrorCode(exception) ?? '')) {
      status = 400;
      code = 'validation_error';
      message = 'Invalid request';
    } else if (isDatabaseUnavailable(exception)) {
      status = 503;
      code = 'service_unavailable';
      message = 'The service is temporarily unavailable. Please try again in a moment.';
      headers = { 'Retry-After': '2' };
    } else {
      const e = exception as ErrorLike | null;
      const s = Number(e?.status ?? e?.statusCode);
      // body-parser / http-errors style errors carry a 4xx status: that's the client's fault
      if (Number.isInteger(s) && s >= 400 && s < 500) {
        status = s;
        code = codeForStatus(s);
        message =
          e?.type === 'entity.parse.failed'
            ? 'Request body is not valid JSON'
            : e?.type === 'entity.too.large'
              ? 'Request body is too large'
              : 'Bad request';
      }
    }

    if (status >= 500) {
      this.logger.error(
        `${req.method} ${req.url} -> ${status} [${requestId}]`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }
    if (headers) for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res
      .status(status)
      .json({ error: { code, message, ...(details === undefined ? {} : { details }), requestId } });
  }
}
