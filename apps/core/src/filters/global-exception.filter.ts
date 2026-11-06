/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
/** biome-ignore-all lint/style/useImportType: <> */
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const exceptionResponse =
      exception instanceof HttpException
        ? exception.getResponse()
        : { message: 'Internal server error' };

    const message =
      typeof exceptionResponse === 'string'
        ? exceptionResponse
        : (exceptionResponse as any).message || 'Internal server error';

    const userId = (request as any).user?.id ?? 'anonymous';
    const exceptionType =
      exception instanceof Error
        ? exception.constructor.name
        : typeof exception;
    const exceptionMessage =
      exception instanceof Error ? exception.message : String(exception);
    const stack =
      exception instanceof Error ? exception.stack : String(exception);

    // Log 5xx at error level with full stack, 4xx at warn level
    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} → ${status} | ${exceptionType}: ${exceptionMessage} | userId: ${userId}`,
        stack,
      );
    } else if (status >= 400) {
      this.logger.warn(
        `${request.method} ${request.url} → ${status} | ${Array.isArray(message) ? message.join(', ') : message} | userId: ${userId}`,
      );
    }

    response.status(status).json({
      success: false,
      message: Array.isArray(message) ? message[0] : message,
      statusCode: status,
      ...(Array.isArray(message) && message.length > 1
        ? { errors: message }
        : {}),
    });
  }
}
