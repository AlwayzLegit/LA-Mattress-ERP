import { type ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';

/**
 * Nest's default filter answers an unexpected error with a bare 500 and
 * logs only its message and stack (see `pinoHttpOptions`). pino-http logs
 * `res.err` on the request line when one is set, through the cause-aware
 * serializer — so hand it the thrown object and let the base filter do
 * the rest. HttpExceptions are deliberate replies, not faults; they stay
 * off the error log.
 */
@Catch()
export class AllExceptionsFilter extends BaseExceptionFilter {
  override catch(exception: unknown, host: ArgumentsHost): void {
    if (!(exception instanceof HttpException)) {
      const res = host.switchToHttp().getResponse<{ err?: unknown } | undefined>();
      if (res && typeof res === 'object') res.err = exception;
    }
    super.catch(exception, host);
  }
}
