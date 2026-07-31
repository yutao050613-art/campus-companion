import { apiRequest, newIdempotencyKey } from "../../utils/api";
import type { DemandItem } from "../../utils/grouping";

Page({
  data: {
    busy: false,
    message: "正在读取我的同行需求…",
    demands: [] as readonly DemandItem[],
  },

  async onShow() {
    await this.load();
  },

  async load() {
    this.setData({ busy: true });
    try {
      const response = await apiRequest<{ readonly items: readonly DemandItem[] }>("/demands");
      this.setData({
        demands: response.data.items,
        message:
          response.data.items.length === 0 ? "还没有同行需求。" : "组内联系方式在 M3 不会公开。",
      });
    } catch (error) {
      this.setData({ message: error instanceof Error ? error.message : "读取失败", demands: [] });
    } finally {
      this.setData({ busy: false });
    }
  },

  openDemand(event: { currentTarget: { dataset: { group?: string; demand?: string } } }) {
    const groupId = event.currentTarget.dataset.group;
    const demandId = event.currentTarget.dataset.demand;
    if (groupId !== undefined && demandId !== undefined) {
      wx.navigateTo({ url: `/pages/group/index?groupId=${groupId}&demandId=${demandId}` });
    }
  },

  async cancel(event: { currentTarget: { dataset: { demand?: string } } }) {
    const demandId = event.currentTarget.dataset.demand;
    if (demandId === undefined) return;
    try {
      await apiRequest(`/demands/${demandId}`, {
        method: "DELETE",
        headers: { "idempotency-key": newIdempotencyKey() },
      });
      wx.showToast({ title: "已撤销", icon: "success" });
      await this.load();
    } catch (error) {
      this.setData({ message: error instanceof Error ? error.message : "撤销失败" });
    }
  },
});
