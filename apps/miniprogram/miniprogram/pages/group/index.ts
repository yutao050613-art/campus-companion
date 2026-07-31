import { apiRequest, newIdempotencyKey } from "../../utils/api";
import type { DemandItem, FormationItem, GroupItem } from "../../utils/grouping";

Page({
  data: {
    groupId: "",
    demandId: "",
    group: null as GroupItem | null,
    busy: false,
    message: "只显示匿名成员；M3 不提供任何联系方式。",
  },

  async onLoad(options: { groupId?: string; demandId?: string }) {
    this.setData({ groupId: options.groupId ?? "", demandId: options.demandId ?? "" });
    await this.load();
  },

  async load() {
    if (this.data.groupId === "") return;
    try {
      const response = await apiRequest<GroupItem>(`/groups/${this.data.groupId}`);
      let demandId = this.data.demandId;
      if (demandId === "") {
        const demands = await apiRequest<{ readonly items: readonly DemandItem[] }>("/demands");
        demandId =
          demands.data.items.find(
            (demand) =>
              demand.routeId === response.data.routeId &&
              demand.windowStart === response.data.windowStart &&
              demand.windowEnd === response.data.windowEnd &&
              (demand.status === "OPEN" || demand.status === "GROUPED"),
          )?.id ?? "";
      }
      this.setData({ group: response.data, demandId });
    } catch (error) {
      this.setData({ message: error instanceof Error ? error.message : "组详情读取失败" });
    }
  },

  async join() {
    if (this.data.demandId === "") {
      wx.showToast({ title: "请先发布相同路线和时间窗的需求", icon: "none" });
      return;
    }
    await this.runGroupAction("join", { demandId: this.data.demandId });
  },

  async leave() {
    await this.runGroupAction("leave");
  },

  async startFormation() {
    this.setData({ busy: true });
    try {
      const response = await apiRequest<FormationItem>(
        `/groups/${this.data.groupId}/formation-rounds`,
        { method: "POST", headers: { "idempotency-key": newIdempotencyKey() } },
      );
      wx.navigateTo({ url: `/pages/formation/index?roundId=${response.data.id}` });
    } catch (error) {
      this.setData({ message: error instanceof Error ? error.message : "发起确认失败" });
    } finally {
      this.setData({ busy: false });
    }
  },

  openFormation() {
    const roundId = this.data.group?.activeRoundId;
    if (roundId !== null && roundId !== undefined) {
      wx.navigateTo({ url: `/pages/formation/index?roundId=${roundId}` });
    }
  },

  async runGroupAction(action: "join" | "leave", data?: unknown) {
    this.setData({ busy: true });
    try {
      const response = await apiRequest<GroupItem>(`/groups/${this.data.groupId}/${action}`, {
        method: "POST",
        headers: { "idempotency-key": newIdempotencyKey() },
        ...(data === undefined ? {} : { data }),
      });
      this.setData({
        group: response.data,
        message: action === "join" ? "已加入候选组。" : "已离开候选组。",
      });
    } catch (error) {
      this.setData({ message: error instanceof Error ? error.message : "操作失败" });
    } finally {
      this.setData({ busy: false });
    }
  },
});
