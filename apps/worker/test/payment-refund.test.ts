import { describe, expect, it, vi } from "vitest";
import { type PaymentRefundRepository, runPaymentRefundSweep } from "../src/payment-refund";

const now = new Date("2026-08-01T12:00:00.000Z");

function repository(overrides: Partial<PaymentRefundRepository> = {}): PaymentRefundRepository {
  return {
    listDuePaymentRoundIds: vi.fn().mockResolvedValue([]),
    invalidatePaymentRound: vi.fn().mockResolvedValue(false),
    listRequestedRefundIds: vi.fn().mockResolvedValue([]),
    settleRefund: vi.fn().mockResolvedValue(false),
    ...overrides,
  };
}

describe("payment timeout and refund sweep", () => {
  it("counts only deadline and refund transitions won by the atomic repository operations", async () => {
    const repo = repository({
      listDuePaymentRoundIds: vi.fn().mockResolvedValue(["round-won", "round-stale"]),
      invalidatePaymentRound: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
      listRequestedRefundIds: vi.fn().mockResolvedValue(["refund-won", "refund-stale"]),
      settleRefund: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
    });
    await expect(runPaymentRefundSweep(repo, now)).resolves.toEqual({
      roundsInvalidated: 1,
      refundsSettled: 1,
    });
    expect(repo.invalidatePaymentRound).toHaveBeenNthCalledWith(1, "round-won", now);
    expect(repo.invalidatePaymentRound).toHaveBeenNthCalledWith(2, "round-stale", now);
    expect(repo.settleRefund).toHaveBeenNthCalledWith(1, "refund-won", now);
    expect(repo.settleRefund).toHaveBeenNthCalledWith(2, "refund-stale", now);
  });

  it("does not settle refunds if selecting expired payment rounds fails", async () => {
    const repo = repository({
      listDuePaymentRoundIds: vi.fn().mockRejectedValue(new Error("database unavailable")),
    });
    await expect(runPaymentRefundSweep(repo, now)).rejects.toThrow("database unavailable");
    expect(repo.listRequestedRefundIds).not.toHaveBeenCalled();
  });
});
