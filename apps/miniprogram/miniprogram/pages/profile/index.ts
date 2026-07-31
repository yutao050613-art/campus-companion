import { apiRequest } from "../../utils/api";

interface SessionResponse {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly user: {
    readonly campusId: string;
    readonly verificationStatus: string;
  };
}

Page({
  data: {
    loggedIn: false,
    busy: false,
    mockCode: "",
    verificationStatus: "NOT_SUBMITTED",
    message: "登录后可提交学生身份认证。",
  },

  onMockCodeInput(event: { detail: { value: string } }) {
    this.setData({ mockCode: event.detail.value.trim() });
  },

  async login() {
    this.setData({ busy: true, message: "正在登录…" });
    try {
      const code = this.data.mockCode || (await wechatLoginCode());
      const response = await apiRequest<SessionResponse>("/auth/wechat/login", {
        method: "POST",
        data: { code },
        authenticated: false,
      });
      const app = getApp<{ globalData: CampusAppGlobalData }>();
      app.globalData.accessToken = response.data.accessToken;
      app.globalData.refreshToken = response.data.refreshToken;
      app.globalData.campusId = response.data.user.campusId;
      this.setData({
        loggedIn: true,
        verificationStatus: response.data.user.verificationStatus,
        message: "登录成功。令牌仅保存在当前小程序进程内。",
      });
    } catch (error) {
      this.setData({ message: error instanceof Error ? error.message : "登录失败" });
    } finally {
      this.setData({ busy: false });
    }
  },

  openVerification() {
    wx.navigateTo({ url: "/pages/student-verification/index" });
  },
});

function wechatLoginCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.login({
      success: ({ code }) => resolve(code),
      fail: ({ errMsg }) => reject(new Error(errMsg)),
    });
  });
}
