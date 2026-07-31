interface SessionResponse {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly user: { readonly campusId: string };
}

interface RequestOptions {
  readonly method?: "GET" | "POST" | "PUT" | "DELETE";
  readonly data?: unknown;
  readonly headers?: Record<string, string>;
  readonly authenticated?: boolean;
  readonly absoluteUrl?: boolean;
}

export async function apiRequest<T>(
  path: string,
  options: RequestOptions = {},
): Promise<MiniProgramResponse<T>> {
  const app = getApp<{ globalData: CampusAppGlobalData }>();
  const response = await rawRequest<T>(path, options, app.globalData.accessToken);
  if (
    response.statusCode !== 401 ||
    options.authenticated === false ||
    app.globalData.refreshToken === ""
  ) {
    assertSuccess(response);
    return response;
  }
  const refreshed = await rawRequest<SessionResponse>(
    "/auth/refresh",
    { method: "POST", data: { refreshToken: app.globalData.refreshToken }, authenticated: false },
    "",
  );
  assertSuccess(refreshed);
  app.globalData.accessToken = refreshed.data.accessToken;
  app.globalData.refreshToken = refreshed.data.refreshToken;
  app.globalData.campusId = refreshed.data.user.campusId;
  const retried = await rawRequest<T>(path, options, refreshed.data.accessToken);
  assertSuccess(retried);
  return retried;
}

export function newIdempotencyKey(): string {
  return `mp-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function rawRequest<T>(
  path: string,
  options: RequestOptions,
  accessToken: string,
): Promise<MiniProgramResponse<T>> {
  const app = getApp<{ globalData: CampusAppGlobalData }>();
  return new Promise((resolve, reject) => {
    wx.request<T>({
      url: options.absoluteUrl === true ? path : `${app.globalData.apiBaseUrl}${path}`,
      method: options.method ?? "GET",
      header: {
        "content-type": "application/json",
        ...(options.authenticated === false || accessToken === ""
          ? {}
          : { authorization: `Bearer ${accessToken}` }),
        ...options.headers,
      },
      ...(options.data === undefined ? {} : { data: options.data }),
      success: resolve,
      fail: (error) => reject(new Error(error.errMsg)),
    });
  });
}

function assertSuccess(response: MiniProgramResponse<unknown>): void {
  if (response.statusCode >= 200 && response.statusCode < 300) return;
  const body = response.data as {
    readonly error?: { readonly code?: string; readonly message?: string };
  };
  throw new Error(
    `${body.error?.code ?? `HTTP_${response.statusCode}`}: ${body.error?.message ?? "请求失败"}`,
  );
}
