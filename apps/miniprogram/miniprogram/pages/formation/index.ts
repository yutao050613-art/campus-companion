import { apiRequest, newIdempotencyKey } from "../../utils/api";
import type { FormationItem } from "../../utils/grouping";

Page({
  data: {
    roundId: "",
    round: null as FormationItem | null,
    consent: false,
    busy: false,
    message: "同意后本轮决定不可修改；超时会作废并回到候选组。",
  },

  async onLoad(options: { roundId?: string }) {
    this.setData({ roundId: options.roundId ?? "" });
    await this.load();
  },

  async load() {
    if (this.data.roundId === "") return;
    try {
      const response = await apiRequest<FormationItem>(`/formation-rounds/${this.data.roundId}`);
      this.setData({ round: response.data });
    } catch (error) {
      this.setData({ message: error instanceof Error ? error.message : "轮次读取失败" });
    }
  },

  onConsentChange(event: { detail: { value: readonly string[] } }) {
    this.setData({ consent: event.detail.value.includes("granted") });
  },

  async accept() {
    if (!this.data.consent || this.data.round === null) {
      wx.showToast({ title: "请先单独同意本轮联系方式共享", icon: "none" });
      return;
    }
    await this.decide({
      decision: "ACCEPT",
      contactConsent: { granted: true, policyVersion: this.data.round.contactPolicyVersion },
    });
  },

  async decline() {
    await this.decide({ decision: "DECLINE" });
  },

  async decide(data: unknown) {
    this.setData({ busy: true });
    try {
      const response = await apiRequest<FormationItem>(
        `/formation-rounds/${this.data.roundId}/confirm`,
        { method: "POST", headers: { "idempotency-key": newIdempotencyKey() }, data },
      );
      this.setData({
        round: response.data,
        message:
          response.data.state === "PAYING"
            ? "全员已确认，请先填写微信号并完成每账号 0.99 元信息服务费。"
            : response.data.state === "INVALIDATED"
              ? "本轮已作废，候选组可重新组织。"
              : "已记录不可变决定，等待其他成员。",
      });
      if (response.data.state === "PAYING") {
        wx.navigateTo({
          url: `/pages/payment/index?roundId=${response.data.id}&groupId=${response.data.groupId}`,
        });
      }
    } catch (error) {
      this.setData({ message: error instanceof Error ? error.message : "确认失败" });
    } finally {
      this.setData({ busy: false });
    }
  },
});
