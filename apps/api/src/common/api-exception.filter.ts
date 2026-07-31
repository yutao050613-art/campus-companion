import { type ErrorCode, makeApiError } from "@campus/contracts";
import type { StructuredLogger } from "@campus/observability";
import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ApplicationError } from "./application-error";

function codeForHttpStatus(statusCode: number): ErrorCode {
  if (statusCode === 401) return "AUTH_REQUIRED";
  if (statusCode === 403) return "RESOURCE_FORBIDDEN";
  if (statusCode === 404) return "RESOURCE_NOT_FOUND";
  if (statusCode === 409) return "IDEMPOTENCY_CONFLICT";
  if (statusCode === 429) return "RATE_LIMITED";
  if (statusCode >= 400 && statusCode < 500) return "VALIDATION_ERROR";
  return "INTERNAL_ERROR";
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  public constructor(private readonly logger: StructuredLogger) {}

  public catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<FastifyRequest>();
    const reply = context.getResponse<FastifyReply>();

    const applicationError = exception instanceof ApplicationError ? exception : undefined;
    const httpException = exception instanceof HttpException ? exception : undefined;
    const statusCode = applicationError?.statusCode ?? httpException?.getStatus() ?? 500;
    const code = applicationError?.code ?? codeForHttpStatus(statusCode);
    const message =
      statusCode >= 500 ? "internal server error" : (applicationError?.message ?? "request failed");

    if (statusCode >= 500) {
      const exceptionType =
        typeof exception === "object" && exception !== null
          ? (exception.constructor?.name ?? "UnknownObject")
          : typeof exception;
      this.logger.error(
        {
          exceptionType,
          requestId: request.id,
          method: request.method,
          path: request.url,
        },
        "unhandled API exception",
      );
    }

    void reply.status(statusCode).send(
      makeApiError({
        code,
        message,
        requestId: String(request.id),
        ...(applicationError?.details === undefined ? {} : { details: applicationError.details }),
      }),
    );
  }
}
