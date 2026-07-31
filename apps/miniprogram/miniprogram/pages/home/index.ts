import { apiRequest } from "../../utils/api";
import {
  type CampusCatalogItem,
  type GroupItem,
  localIsoDate,
  type RouteCatalogItem,
  routeLabel,
  windowLabel,
} from "../../utils/grouping";

Page({
  data: {
    busy: false,
    message: "正在读取后台启用的固定路线…",
    routes: [] as readonly RouteCatalogItem[],
    routeLabels: [] as readonly string[],
    routeIndex: 0,
    windowLabels: [] as readonly string[],
    windowIndex: 0,
    groups: [] as readonly GroupItem[],
  },

  async onShow() {
    await this.loadCatalog();
  },

  async onPullDownRefresh() {
    try {
      await this.loadGroups();
    } finally {
      wx.stopPullDownRefresh();
    }
  },

  async loadCatalog() {
    this.setData({ busy: true });
    try {
      const campuses = await apiRequest<readonly CampusCatalogItem[]>("/campuses", {
        authenticated: false,
      });
      const campus = campuses.data[0];
      if (campus === undefined) throw new Error("暂无已启用校区");
      const app = getApp<{ globalData: CampusAppGlobalData }>();
      if (app.globalData.campusId === "") app.globalData.campusId = campus.id;
      const response = await apiRequest<readonly RouteCatalogItem[]>(
        `/campuses/${encodeURIComponent(app.globalData.campusId)}/routes?date=${localIsoDate()}`,
        { authenticated: false },
      );
      this.setData({
        routes: response.data,
        routeLabels: response.data.map(routeLabel),
        routeIndex: 0,
        windowIndex: 0,
        windowLabels: response.data[0]?.windows.map(windowLabel) ?? [],
      });
      await this.loadGroups();
    } catch (error) {
      this.setData({
        message: error instanceof Error ? error.message : "路线读取失败",
        groups: [],
      });
    } finally {
      this.setData({ busy: false });
    }
  },

  async onRouteChange(event: { detail: { value: string } }) {
    const routeIndex = Number(event.detail.value);
    this.setData({
      routeIndex,
      windowIndex: 0,
      windowLabels: this.data.routes[routeIndex]?.windows.map(windowLabel) ?? [],
    });
    await this.loadGroups();
  },

  async onWindowChange(event: { detail: { value: string } }) {
    this.setData({ windowIndex: Number(event.detail.value) });
    await this.loadGroups();
  },

  async loadGroups() {
    const route = this.data.routes[this.data.routeIndex];
    const window = route?.windows[this.data.windowIndex];
    if (route === undefined || window === undefined) {
      this.setData({ groups: [], message: "当前日期暂无可用路线时间窗" });
      return;
    }
    try {
      const response = await apiRequest<{ readonly items: readonly GroupItem[] }>(
        `/groups?routeId=${encodeURIComponent(route.id)}&windowStart=${encodeURIComponent(window.start)}`,
      );
      this.setData({
        groups: response.data.items,
        message:
          response.data.items.length === 0
            ? "当前还没有候选组，可以先发布需求。"
            : "只显示匿名成员和座位数。",
      });
    } catch (error) {
      this.setData({
        groups: [],
        message: error instanceof Error ? `${error.message}；请先在“我的”登录。` : "候选组读取失败",
      });
    }
  },

  openGroup(event: { currentTarget: { dataset: { id?: string } } }) {
    const id = event.currentTarget.dataset.id;
    if (id !== undefined) wx.navigateTo({ url: `/pages/group/index?groupId=${id}` });
  },
});
