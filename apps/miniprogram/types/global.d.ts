interface CampusAppGlobalData {
  apiBaseUrl: string;
  milestone: "M2";
  accessToken: string;
  refreshToken: string;
  campusId: string;
}

declare function App<T extends Record<string, unknown>>(options: T): void;
declare function getApp<T extends { globalData: CampusAppGlobalData }>(): T;

type PageInstance<Data extends Record<string, unknown>> = {
  data: Data;
  setData(update: Partial<Data>): void;
};

declare function Page<
  Data extends Record<string, unknown>,
  Methods extends Record<string, unknown> = Record<string, unknown>,
>(options: { data: Data } & Methods & ThisType<PageInstance<Data> & Methods>): void;

interface MiniProgramResponse<T> {
  statusCode: number;
  data: T;
  header: Record<string, string>;
}

declare const wx: {
  login(options: {
    success(result: { code: string }): void;
    fail(error: { errMsg: string }): void;
  }): void;
  request<T>(options: {
    url: string;
    method?: "GET" | "POST" | "PUT";
    header?: Record<string, string>;
    data?: unknown;
    success(response: MiniProgramResponse<T>): void;
    fail(error: { errMsg: string }): void;
  }): void;
  chooseMedia(options: {
    count: number;
    mediaType: readonly ["image"];
    sourceType: readonly ["album", "camera"];
    success(result: { tempFiles: readonly [{ tempFilePath: string }] }): void;
    fail(error: { errMsg: string }): void;
  }): void;
  getFileSystemManager(): {
    readFile(options: {
      filePath: string;
      success(result: { data: ArrayBuffer }): void;
      fail(error: { errMsg: string }): void;
    }): void;
  };
  showToast(options: { title: string; icon: "none" | "success" }): void;
  navigateTo(options: { url: string }): void;
};
