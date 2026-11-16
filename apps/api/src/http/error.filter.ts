import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { type Request, type Response } from 'express';
import { ZodError } from 'zod';
import { AppError, codeForStatus } from './errors';

type ErrorLike = { status?: unknown; statusCode?: unknown; type?: unknown; message?: unknown };

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
