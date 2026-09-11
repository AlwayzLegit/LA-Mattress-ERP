import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { Response } from 'express';
// Database errors include SQL parameters. Never hand them to the generic logger.
@Catch()
export class ChatExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const status = error instanceof HttpException ? error.getStatus() : 503;
    const message =
      error instanceof HttpException ? error.message : 'Live chat is temporarily unavailable';
    response.setHeader('Cache-Control', 'no-store');
    response.status(status).json({ statusCode: status, message });
  }
}
