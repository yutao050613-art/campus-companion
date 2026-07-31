import { describe, expect, it } from "vitest";
import { ERROR_CODES, makeApiError } from "../src/index";

describe("API error contract", () => {
  it("keeps error codes unique", () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });

  it("does not invent fields while wrapping an error", () => {
    const response = makeApiError({
      code: "RESOURCE_NOT_FOUND",
      message: "resource not found",
      requestId: "req_test",
    });

    expect(response).toEqual({
      error: {
        code: "RESOURCE_NOT_FOUND",
        message: "resource not found",
        requestId: "req_test",
      },
    });
  });
});
