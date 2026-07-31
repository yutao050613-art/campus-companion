import { describe, expect, it } from "vitest";
import { assertNever, expireVerificationAtBoundary, isVerificationActive } from "../src/index";

describe("domain foundation", () => {
  it("throws for an unreachable runtime value", () => {
    expect(() => assertNever("unexpected" as never)).toThrow("Unexpected domain value");
  });

  it("authorizes only a VERIFIED credential strictly before its expiry", () => {
    expect(
      isVerificationActive("VERIFIED", "2026-08-01T00:00:00.000Z", "2026-07-31T23:59:59.999Z"),
    ).toBe(true);
    expect(
      isVerificationActive("VERIFIED", "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z"),
    ).toBe(false);
    expect(
      isVerificationActive("VERIFIED", "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.001Z"),
    ).toBe(false);
    expect(
      isVerificationActive(
        "VERIFICATION_EXPIRED",
        "2026-08-01T00:00:00.000Z",
        "2026-07-01T00:00:00.000Z",
      ),
    ).toBe(false);
    expect(isVerificationActive("VERIFIED", null, "2026-07-01T00:00:00.000Z")).toBe(false);
    expect(isVerificationActive("VERIFIED", "invalid", "2026-07-01T00:00:00.000Z")).toBe(false);
    expect(isVerificationActive("VERIFIED", "2026-08-01T00:00:00.000Z", "invalid")).toBe(false);
  });

  it("expires at the exact boundary and remains idempotent under replay or stale work", () => {
    expect(
      expireVerificationAtBoundary(
        "VERIFIED",
        "2026-08-01T00:00:00.000Z",
        "2026-07-31T23:59:59.999Z",
      ),
    ).toBe("VERIFIED");
    expect(
      expireVerificationAtBoundary(
        "VERIFIED",
        "2026-08-01T00:00:00.000Z",
        "2026-08-01T00:00:00.000Z",
      ),
    ).toBe("VERIFICATION_EXPIRED");
    expect(
      expireVerificationAtBoundary(
        "VERIFICATION_EXPIRED",
        "2026-08-01T00:00:00.000Z",
        "2026-07-01T00:00:00.000Z",
      ),
    ).toBe("VERIFICATION_EXPIRED");
    expect(expireVerificationAtBoundary("REJECTED", null, "2026-08-01T00:00:00.000Z")).toBe(
      "REJECTED",
    );
  });

  it("rejects corrupted VERIFIED expiry inputs", () => {
    expect(() =>
      expireVerificationAtBoundary("VERIFIED", null, "2026-08-01T00:00:00.000Z"),
    ).toThrow("requires valid");
    expect(() =>
      expireVerificationAtBoundary("VERIFIED", "invalid", "2026-08-01T00:00:00.000Z"),
    ).toThrow("requires valid");
    expect(() =>
      expireVerificationAtBoundary("VERIFIED", "2026-08-01T00:00:00.000Z", "invalid"),
    ).toThrow("requires valid");
  });
});
