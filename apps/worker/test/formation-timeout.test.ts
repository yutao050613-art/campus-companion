import { describe, expect, it, vi } from "vitest";
import {
  type FormationDeadlineRepository,
  runFormationDeadlineSweep,
} from "../src/formation-timeout";

const now = new Date("2026-08-01T12:00:00.000Z");

function repository(overrides: Partial<FormationDeadlineRepository> = {}) {
  const base: FormationDeadlineRepository = {
    listDueConfirmationRoundIds: vi.fn().mockResolvedValue([]),
    invalidateConfirmationRound: vi.fn().mockResolvedValue(false),
    listExpiredRecruitableGroupIds: vi.fn().mockResolvedValue([]),
    expireRecruitableGroup: vi.fn().mockResolvedValue(false),
  };
  return { ...base, ...overrides };
}

describe("formation deadline sweep", () => {
  it("invalidates and expires only rows won by the atomic repository transition", async () => {
    const repo = repository({
      listDueConfirmationRoundIds: vi.fn().mockResolvedValue(["round-won", "round-stale"]),
      invalidateConfirmationRound: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
      listExpiredRecruitableGroupIds: vi.fn().mockResolvedValue(["group-won", "group-stale"]),
      expireRecruitableGroup: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
    });
    await expect(runFormationDeadlineSweep(repo, now)).resolves.toEqual({
      roundsInvalidated: 1,
      groupsExpired: 1,
    });
    expect(repo.invalidateConfirmationRound).toHaveBeenNthCalledWith(1, "round-won", now);
    expect(repo.invalidateConfirmationRound).toHaveBeenNthCalledWith(2, "round-stale", now);
    expect(repo.expireRecruitableGroup).toHaveBeenNthCalledWith(1, "group-won", now);
    expect(repo.expireRecruitableGroup).toHaveBeenNthCalledWith(2, "group-stale", now);
  });

  it("is a no-op when another worker already processed every candidate", async () => {
    const repo = repository({
      listDueConfirmationRoundIds: vi.fn().mockResolvedValue(["round"]),
      listExpiredRecruitableGroupIds: vi.fn().mockResolvedValue(["group"]),
    });
    await expect(runFormationDeadlineSweep(repo, now)).resolves.toEqual({
      roundsInvalidated: 0,
      groupsExpired: 0,
    });
  });

  it("fails closed so an infrastructure error remains observable and retryable", async () => {
    const repo = repository({
      listDueConfirmationRoundIds: vi.fn().mockRejectedValue(new Error("database unavailable")),
    });
    await expect(runFormationDeadlineSweep(repo, now)).rejects.toThrow("database unavailable");
    expect(repo.listExpiredRecruitableGroupIds).not.toHaveBeenCalled();
  });
});
