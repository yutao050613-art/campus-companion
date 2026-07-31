import type { ErrorCode, SafeErrorDetails } from "@campus/contracts";

export class ApplicationError extends Error {
  public constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly statusCode: number,
    public readonly details?: SafeErrorDetails,
  ) {
    super(message);
    this.name = "ApplicationError";
  }
}
