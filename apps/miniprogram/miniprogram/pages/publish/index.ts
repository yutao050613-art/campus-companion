import { apiRequest, newIdempotencyKey } from "../../utils/api";
import {
  type CampusCatalogItem,
  type DemandItem,
  localIsoDate,
  type RouteCatalogItem,
  routeLabel,
  windowLabel,
} from "../../utils/grouping";

Page({
  data: {
    busy: false,
    message: "发布和加入均免费；达到至少两个认证账号后才可发起成团确认。",
    routes: [] as readonly RouteCatalogItem[],
    routeLabels: [] as readonly string[],
    routeIndex: 0,
    windowLabels: [] as readonly string[],
    windowIndex: 0,
    seatIndex: 0,
    seatLabels: ["1 座", "2 座", "3 座"] as readonly string[],
    luggage: "NONE",
    genderPreference: "ANY",
  },

  async onShow() {
    await this.loadCatalog();
  },

  async loadCatalog() {
    try {
      const app = getApp<{ globalData: CampusAppGlobalData }>();
      if (app.globalData.campusId === "") {
        const campuses = await apiRequest<readonly CampusCatalogItem[]>("/campuses", {
          authenticated: false,
        });
        const campus = campuses.data[0];
        if (campus === undefined) throw new Error("暂无已启用校区");
        app.globalData.campusId = campus.id;
      }
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
    } catch (error) {
      this.setData({ message: error instanceof Error ? error.message : "路线读取失败" });
    }
  },

  onRouteChange(event: { detail: { value: string } }) {
    const routeIndex = Number(event.detail.value);
    this.setData({
      routeIndex,
      windowIndex: 0,
      windowLabels: this.data.routes[routeIndex]?.windows.map(windowLabel) ?? [],
    });
  },

  onWindowChange(event: { detail: { value: string } }) {
    this.setData({ windowIndex: Number(event.detail.value) });
  },

  onSeatChange(event: { detail: { value: string } }) {
    this.setData({ seatIndex: Number(event.detail.value) });
  },

  onLuggageChange(event: { detail: { value: string } }) {
    this.setData({ luggage: event.detail.value });
  },

  onPreferenceChange(event: { detail: { value: string } }) {
    this.setData({ genderPreference: event.detail.value });
  },

  async publish() {
    const route = this.data.routes[this.data.routeIndex];
    const window = route?.windows[this.data.windowIndex];
    if (route === undefined || window === undefined) {
      wx.showToast({ title: "请选择有效路线和时间", icon: "none" });
      return;
    }
    this.setData({ busy: true });
    try {
      const response = await apiRequest<DemandItem>("/demands", {
        method: "POST",
        headers: { "idempotency-key": newIdempotencyKey() },
        data: {
          routeId: route.id,
          windowStart: window.start,
          windowEnd: window.end,
          seatCount: this.data.seatIndex + 1,
          luggage: this.data.luggage,
          genderPreference: this.data.genderPreference,
        },
      });
      this.setData({ message: "需求已免费发布。加入其他候选组时使用同一需求。" });
      if (response.data.groupId !== null) {
        wx.navigateTo({
          url: `/pages/group/index?groupId=${response.data.groupId}&demandId=${response.data.id}`,
        });
      }
    } catch (error) {
      this.setData({ message: error instanceof Error ? error.message : "发布失败" });
    } finally {
      this.setData({ busy: false });
    }
  },
});
