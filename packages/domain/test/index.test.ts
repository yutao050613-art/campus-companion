import { describe, expect, it } from "vitest";
import {
  assertFormationReady,
  assertNever,
  expireVerificationAtBoundary,
  isGenderPreferenceCompatible,
  isVerificationActive,
  summarizeGroupingMembers,
  windowsOverlap,
} from "../src/index";

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

  it("derives readiness from distinct accounts rather than occupied seats", () => {
    expect(
      summarizeGroupingMembers([
        { userId: "a", seatCount: 3, gender: "FEMALE", preference: "ANY" },
      ]),
    ).toEqual({ accountCount: 1, occupiedSeats: 3, remainingSeats: 1, state: "RECRUITING" });
    expect(
      summarizeGroupingMembers([
        { userId: "a", seatCount: 1, gender: "FEMALE", preference: "ANY" },
        { userId: "b", seatCount: 3, gender: "MALE", preference: "ANY" },
      ]),
    ).toEqual({ accountCount: 2, occupiedSeats: 4, remainingSeats: 0, state: "READY" });
    expect(summarizeGroupingMembers([])).toEqual({
      accountCount: 0,
      occupiedSeats: 0,
      remainingSeats: 4,
      state: "EXPIRED",
    });
  });

  it("rejects duplicate users, invalid seats, and every fifth-seat combination", () => {
    expect(() =>
      summarizeGroupingMembers([
        { userId: "a", seatCount: 1, gender: "FEMALE", preference: "ANY" },
        { userId: "a", seatCount: 1, gender: "FEMALE", preference: "ANY" },
      ]),
    ).toThrow("distinct");
    for (const seatCount of [0, 1.5, 4]) {
      expect(() =>
        summarizeGroupingMembers([{ userId: "a", seatCount, gender: "FEMALE", preference: "ANY" }]),
      ).toThrow("seatCount");
    }
    expect(() =>
      summarizeGroupingMembers([
        { userId: "a", seatCount: 3, gender: "FEMALE", preference: "ANY" },
        { userId: "b", seatCount: 2, gender: "FEMALE", preference: "ANY" },
      ]),
    ).toThrow("fifth");
    expect(() =>
      summarizeGroupingMembers([{ userId: "", seatCount: 1, gender: "FEMALE", preference: "ANY" }]),
    ).toThrow("distinct");
  });

  it("applies same-gender preference symmetrically and rejects undisclosed gender", () => {
    expect(
      isGenderPreferenceCompatible([
        { userId: "a", seatCount: 1, gender: "UNDISCLOSED", preference: "ANY" },
        { userId: "b", seatCount: 1, gender: "MALE", preference: "ANY" },
      ]),
    ).toBe(true);
    expect(
      isGenderPreferenceCompatible([
        { userId: "a", seatCount: 1, gender: "FEMALE", preference: "SAME_GENDER_ONLY" },
        { userId: "b", seatCount: 1, gender: "FEMALE", preference: "ANY" },
      ]),
    ).toBe(true);
    expect(
      isGenderPreferenceCompatible([
        { userId: "a", seatCount: 1, gender: "FEMALE", preference: "ANY" },
        { userId: "b", seatCount: 1, gender: "MALE", preference: "SAME_GENDER_ONLY" },
      ]),
    ).toBe(false);
    expect(
      isGenderPreferenceCompatible([
        { userId: "a", seatCount: 1, gender: "UNDISCLOSED", preference: "SAME_GENDER_ONLY" },
      ]),
    ).toBe(false);
    expect(isGenderPreferenceCompatible([])).toBe(true);
  });

  it("requires both readiness and compatible preferences before formation", () => {
    expect(() =>
      assertFormationReady([{ userId: "a", seatCount: 2, gender: "FEMALE", preference: "ANY" }]),
    ).toThrow("two distinct");
    expect(() =>
      assertFormationReady([
        { userId: "a", seatCount: 1, gender: "FEMALE", preference: "SAME_GENDER_ONLY" },
        { userId: "b", seatCount: 1, gender: "MALE", preference: "ANY" },
      ]),
    ).toThrow("incompatible");
    expect(
      assertFormationReady([
        { userId: "a", seatCount: 1, gender: "MALE", preference: "ANY" },
        { userId: "b", seatCount: 2, gender: "FEMALE", preference: "ANY" },
      ]).state,
    ).toBe("READY");
  });

  it("uses half-open overlap semantics and rejects malformed dates", () => {
    const at = (minute: number): Date => new Date(Date.UTC(2026, 7, 1, 10, minute));
    expect(windowsOverlap(at(0), at(30), at(29), at(59))).toBe(true);
    expect(windowsOverlap(at(0), at(30), at(30), at(59))).toBe(false);
    expect(windowsOverlap(at(30), at(59), at(0), at(30))).toBe(false);
    expect(() => windowsOverlap(at(30), at(0), at(0), at(30))).toThrow("later");
    expect(() => windowsOverlap(new Date("invalid"), at(30), at(0), at(30))).toThrow("invalid");
  });
});
