import { apiRequest } from "../../utils/api";

interface Contact {
  readonly label: string;
  readonly wechatId: string;
}

Page({
  data: {
    groupId: "",
    contacts: [] as readonly Contact[],
    message: "仅向已确认、已付款并同意分享联系方式的本组成员显示。",
  },

  async onLoad(options: { groupId?: string }) {
    this.setData({ groupId: options.groupId ?? "" });
    await this.load();
  },

  async onShow() {
    if (this.data.groupId !== "") await this.load();
  },

  async load() {
    if (this.data.groupId === "") return;
    try {
      const response = await apiRequest<readonly Contact[]>(
        `/groups/${this.data.groupId}/contacts`,
      );
      this.setData({ contacts: response.data, message: "请自行沟通，并通过正规平台叫车。" });
    } catch (error) {
      this.setData({
        contacts: [],
        message: error instanceof Error ? error.message : "联系方式尚未解锁",
      });
    }
  },
});
