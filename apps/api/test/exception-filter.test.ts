import type { StructuredLogger } from "@campus/observability";
import { type ArgumentsHost, HttpException } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { ApiExceptionFilter } from "../src/common/api-exception.filter";
import { ApplicationError } from "../src/common/application-error";

function createFilterHarness(): {
  run: (exception: unknown) => void;
  loggerError: ReturnType<typeof vi.fn>;
  getPayload: () => unknown;
} {
  let payload: unknown;
  const loggerError = vi.fn();
  const logger = { error: loggerError } as unknown as StructuredLogger;
  const request = {
    id: "req_test",
    method: "POST",
    url: "/v1/test",
  } as FastifyRequest;
  const reply = {
    status: vi.fn(() => reply),
    send: vi.fn((value: unknown) => {
      payload = value;
      return reply;
    }),
  } as unknown as FastifyReply;
  const host = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => reply,
    }),
  } as unknown as ArgumentsHost;
  const filter = new ApiExceptionFilter(logger);

  return {
    run: (exception: unknown) => filter.catch(exception, host),
    loggerError,
    getPayload: () => payload,
  };
}

describe("ApiExceptionFilter", () => {
  it.each([
    [400, "VALIDATION_ERROR"],
    [401, "AUTH_REQUIRED"],
    [403, "RESOURCE_FORBIDDEN"],
    [404, "RESOURCE_NOT_FOUND"],
    [409, "IDEMPOTENCY_CONFLICT"],
    [429, "RATE_LIMITED"],
  ] as const)("maps HTTP %i to %s", (statusCode, expectedCode) => {
    const harness = createFilterHarness();

    harness.run(new HttpException("must not leak", statusCode));

    expect(harness.getPayload()).toEqual({
      error: {
        code: expectedCode,
        message: "request failed",
        requestId: "req_test",
      },
    });
    expect(harness.loggerError).not.toHaveBeenCalled();
  });

  it("preserves an explicitly safe application error and structured details", () => {
    const harness = createFilterHarness();

    harness.run(
      new ApplicationError("STUDENT_NOT_VERIFIED", "verification required", 422, {
        field: "verification",
      }),
    );

    expect(harness.getPayload()).toEqual({
      error: {
        code: "STUDENT_NOT_VERIFIED",
        message: "verification required",
        requestId: "req_test",
        details: { field: "verification" },
      },
    });
  });

  it("sanitizes unknown server errors and records one structured error log", () => {
    const harness = createFilterHarness();

    harness.run(new Error("CANARY_INTERNAL_SECRET"));

    expect(harness.getPayload()).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "internal server error",
        requestId: "req_test",
      },
    });
    expect(JSON.stringify(harness.getPayload())).not.toContain("CANARY_INTERNAL_SECRET");
    expect(harness.loggerError).toHaveBeenCalledOnce();
    expect(JSON.stringify(harness.loggerError.mock.calls)).not.toContain("CANARY_INTERNAL_SECRET");
  });
});
