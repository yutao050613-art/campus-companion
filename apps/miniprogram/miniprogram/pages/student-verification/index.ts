import { apiRequest, newIdempotencyKey } from "../../utils/api";

type EvidenceType = "STUDENT_CARD" | "WECOM_SCREENSHOT";

interface Verification {
  readonly id: string;
  readonly status: string;
  readonly studentNumberLast4: string;
  readonly reasonCode: string | null;
  readonly evidenceTypes: readonly EvidenceType[];
}

interface UploadResponse {
  readonly verification: Verification;
  readonly uploads: readonly {
    readonly type: EvidenceType;
    readonly uploadUrl: string;
    readonly uploadExpiresAt: string;
  }[];
}

Page({
  data: {
    studentNumber: "",
    genderDeclaration: "UNDISCLOSED",
    evidenceTypes: ["STUDENT_CARD"] as readonly EvidenceType[],
    studentCardSelected: true,
    wecomSelected: false,
    consent: false,
    busy: false,
    status: "NOT_SUBMITTED",
    reasonCode: "",
    message: "可提交企业微信身份截图或学生卡照片，至少选择一种。",
  },

  async onLoad() {
    try {
      const response = await apiRequest<Verification>("/verifications");
      this.setData({
        status: response.data.status,
        reasonCode: response.data.reasonCode ?? "",
        evidenceTypes:
          response.data.evidenceTypes.length > 0
            ? response.data.evidenceTypes
            : (["STUDENT_CARD"] as readonly EvidenceType[]),
        studentCardSelected: response.data.evidenceTypes.includes("STUDENT_CARD"),
        wecomSelected: response.data.evidenceTypes.includes("WECOM_SCREENSHOT"),
      });
    } catch {
      // 尚未申请时接口返回 404；页面保持初始状态。
    }
  },

  onStudentNumberInput(event: { detail: { value: string } }) {
    this.setData({ studentNumber: event.detail.value.trim().toUpperCase() });
  },

  onGenderChange(event: { detail: { value: string } }) {
    this.setData({ genderDeclaration: event.detail.value });
  },

  onEvidenceChange(event: { detail: { value: readonly EvidenceType[] } }) {
    this.setData({
      evidenceTypes: event.detail.value,
      studentCardSelected: event.detail.value.includes("STUDENT_CARD"),
      wecomSelected: event.detail.value.includes("WECOM_SCREENSHOT"),
    });
  },

  onConsentChange(event: { detail: { value: readonly string[] } }) {
    this.setData({ consent: event.detail.value.includes("accepted") });
  },

  openSensitivePolicy() {
    wx.navigateTo({ url: "/pages/policies/sensitive-info" });
  },

  async submit() {
    if (
      !this.data.consent ||
      !/^[A-Z0-9]{4,64}$/.test(this.data.studentNumber) ||
      this.data.evidenceTypes.length < 1
    ) {
      wx.showToast({ title: "请填写学号、选择材料并确认同意", icon: "none" });
      return;
    }
    this.setData({ busy: true, message: "正在创建私有上传凭证…" });
    try {
      const app = getApp<{ globalData: CampusAppGlobalData }>();
      const draft = await apiRequest<UploadResponse>("/verifications", {
        method: "POST",
        headers: { "idempotency-key": newIdempotencyKey() },
        data: {
          campusId: app.globalData.campusId,
          studentNumber: this.data.studentNumber,
          genderDeclaration: this.data.genderDeclaration,
          sensitiveInfoConsentVersion: "sensitive-info-v1",
          evidenceTypes: this.data.evidenceTypes,
        },
      });
      await uploadAndSubmit(draft.data);
      this.setData({ status: "PENDING", message: "材料已提交，待审核期间后台可受控查看。" });
      wx.showToast({ title: "提交成功", icon: "success" });
    } catch (error) {
      this.setData({ message: error instanceof Error ? error.message : "提交失败" });
    } finally {
      this.setData({ busy: false });
    }
  },

  async resubmit() {
    if (this.data.evidenceTypes.length < 1) {
      wx.showToast({ title: "请至少选择一种材料", icon: "none" });
      return;
    }
    this.setData({ busy: true, message: "正在创建补交凭证…" });
    try {
      const current = await apiRequest<Verification>("/verifications");
      const draft = await apiRequest<UploadResponse>(
        `/verifications/${current.data.id}/resubmission-upload`,
        {
          method: "POST",
          headers: { "idempotency-key": newIdempotencyKey() },
          data: { evidenceTypes: this.data.evidenceTypes },
        },
      );
      await uploadAndSubmit(draft.data);
      this.setData({ status: "RESUBMISSION_PENDING", message: "补交材料已提交。" });
    } catch (error) {
      this.setData({ message: error instanceof Error ? error.message : "补交失败" });
    } finally {
      this.setData({ busy: false });
    }
  },
});

async function uploadAndSubmit(draft: UploadResponse): Promise<void> {
  if (draft.uploads.length < 1 || draft.uploads.length > 2) {
    throw new Error("上传凭证数量异常");
  }
  const uploadedEvidence: { type: EvidenceType; uploadEtag: string }[] = [];
  for (const upload of draft.uploads) {
    wx.showToast({
      title: upload.type === "STUDENT_CARD" ? "请选择学生卡照片" : "请选择企业微信截图",
      icon: "none",
    });
    const content = await readFile(await chooseImage());
    const uploaded = await apiRequest<ArrayBuffer>(upload.uploadUrl, {
      method: "PUT",
      data: content,
      headers: { "content-type": detectImageContentType(content) },
      authenticated: false,
      absoluteUrl: true,
    });
    const etag = uploaded.header["etag"];
    if (!etag) throw new Error("上传响应缺少完整性摘要");
    uploadedEvidence.push({ type: upload.type, uploadEtag: etag });
  }
  await apiRequest(`/verifications/${draft.verification.id}/submit`, {
    method: "POST",
    headers: { "idempotency-key": newIdempotencyKey() },
    data: { uploads: uploadedEvidence },
  });
}

function detectImageContentType(content: ArrayBuffer): "image/png" | "image/jpeg" {
  const bytes = new Uint8Array(content);
  if (
    bytes.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)
  ) {
    return "image/png";
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  throw new Error("仅支持 JPEG 或 PNG 图片");
}

function chooseImage(): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.chooseMedia({
      count: 1,
      mediaType: ["image"],
      sourceType: ["album", "camera"],
      success: ({ tempFiles }) => resolve(tempFiles[0].tempFilePath),
      fail: ({ errMsg }) => reject(new Error(errMsg)),
    });
  });
}

function readFile(filePath: string): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath,
      success: ({ data }) => resolve(data),
      fail: ({ errMsg }) => reject(new Error(errMsg)),
    });
  });
}
