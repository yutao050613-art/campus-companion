import { apiRequest, newIdempotencyKey } from "../../utils/api";

interface ServiceOrder {
  readonly id: string;
  readonly status: string;
  readonly amountFen: 99;
  readonly expiresAt: string;
}

interface Prepay {
  readonly provider: "MOCK";
  readonly intentId: string;
  readonly amountFen: 99;
  readonly expiresAt: string;
}

interface Me {
  readonly hasWechatContact: boolean;
}

Page({
  data: {
    roundId: "",
    groupId: "",
    wechatId: "",
    order: null as ServiceOrder | null,
    prepay: null as Prepay | null,
    busy: false,
    message: "请先保存自己的微信号；所有成员付款完成后才会公开。",
  },

  async onLoad(options: { roundId?: string; groupId?: string }) {
    this.setData({ roundId: options.roundId ?? "", groupId: options.groupId ?? "" });
    await this.loadProfile();
  },

  onWechatIdInput(event: { detail: { value: string } }) {
    this.setData({ wechatId: event.detail.value.trim() });
  },

  async loadProfile() {
    try {
      const response = await apiRequest<Me>("/me");
      if (response.data.hasWechatContact) {
        this.setData({ message: "已保存微信号。创建订单后可进入本地模拟支付。" });
      }
    } catch (error) {
      this.setData({ message: error instanceof Error ? error.message : "读取账户状态失败" });
    }
  },

  async saveContact() {
    if (this.data.wechatId === "") {
      wx.showToast({ title: "请填写微信号", icon: "none" });
      return false;
    }
    await apiRequest("/me/contact", {
      method: "POST",
      headers: { "idempotency-key": newIdempotencyKey() },
      data: { wechatId: this.data.wechatId },
    });
    return true;
  },

  async preparePayment() {
    if (this.data.roundId === "" || this.data.groupId === "") return;
    this.setData({ busy: true });
    try {
      const profile = await apiRequest<Me>("/me");
      if (!profile.data.hasWechatContact && !(await this.saveContact())) return;
      const order = await apiRequest<ServiceOrder>(`/groups/${this.data.groupId}/service-orders`, {
        method: "POST",
        headers: { "idempotency-key": newIdempotencyKey() },
        data: { roundId: this.data.roundId },
      });
      const prepay = await apiRequest<Prepay>(`/service-orders/${order.data.id}/prepay`, {
        method: "POST",
        headers: { "idempotency-key": newIdempotencyKey() },
      });
      this.setData({
        order: order.data,
        prepay: prepay.data,
        message: "订单已准备：本开发环境使用模拟支付，真实微信支付将在 M5 经过验证后接入。",
      });
    } catch (error) {
      this.setData({ message: error instanceof Error ? error.message : "创建订单失败" });
    } finally {
      this.setData({ busy: false });
    }
  },

  async settleMock() {
    if (this.data.order === null || this.data.prepay === null) return;
    this.setData({ busy: true });
    try {
      const response = await apiRequest<ServiceOrder>(
        `/service-orders/${this.data.order.id}/mock-settlement`,
        {
          method: "POST",
          headers: { "idempotency-key": newIdempotencyKey() },
          data: { intentId: this.data.prepay.intentId },
        },
      );
      this.setData({ order: response.data });
      if (response.data.status === "DELIVERED") {
        wx.navigateTo({ url: `/pages/contacts/index?groupId=${this.data.groupId}` });
        return;
      }
      this.setData({ message: "付款已记录，正在等待其他成员付款；未付款成员超时会触发全额退款。" });
    } catch (error) {
      this.setData({ message: error instanceof Error ? error.message : "模拟支付失败" });
    } finally {
      this.setData({ busy: false });
    }
  },
});
