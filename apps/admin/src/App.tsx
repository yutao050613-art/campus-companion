import { type FormEvent, useEffect, useState } from "react";

const apiBaseUrl = (import.meta.env["VITE_API_BASE_URL"] as string | undefined) ?? "/v1";

interface VerificationItem {
  readonly id: string;
  readonly campusId: string;
  readonly studentNumberLast4: string;
  readonly status: string;
  readonly submittedAt: string | null;
  readonly reviewedAt: string | null;
  readonly availableAssetTypes: readonly ("STUDENT_CARD" | "WECOM_SCREENSHOT")[];
  readonly reasonCode: string | null;
}

interface ApiErrorBody {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly requestId?: string;
  };
}

export function App() {
  const [csrfToken, setCsrfToken] = useState("");
  const [campusId, setCampusId] = useState("");
  const [items, setItems] = useState<readonly VerificationItem[]>([]);
  const [selected, setSelected] = useState<VerificationItem | null>(null);
  const [materialUrl, setMaterialUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("请使用管理员账号与动态验证码登录。 ");

  useEffect(() => {
    return () => {
      if (materialUrl !== "") URL.revokeObjectURL(materialUrl);
    };
  }, [materialUrl]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    await run(async () => {
      const response = await api("/admin/auth/login", {
        method: "POST",
        body: JSON.stringify({
          username: String(form.get("username") ?? ""),
          password: String(form.get("password") ?? ""),
          totpCode: String(form.get("totpCode") ?? ""),
        }),
      });
      const body = (await response.json()) as { csrfToken: string };
      setCsrfToken(body.csrfToken);
      setMessage("登录成功。请输入已授权校区 ID 后加载审核队列。 ");
      formElement.reset();
    });
  }

  async function loadQueue() {
    await run(async () => {
      const response = await api(`/admin/verifications?campusId=${encodeURIComponent(campusId)}`, {
        headers: securityHeaders(csrfToken),
      });
      const body = (await response.json()) as { items: readonly VerificationItem[] };
      setItems(body.items);
      setSelected(null);
      clearMaterial();
      setMessage(`已加载 ${body.items.length} 条脱敏审核记录。`);
    });
  }

  async function review(decision: "APPROVE" | "REJECT" | "REQUIRE_RESUBMISSION") {
    if (selected === null) return;
    const reasonCode =
      decision === "APPROVE"
        ? undefined
        : window.prompt("请输入大写原因代码，例如 DOCUMENT_UNREADABLE");
    if (decision !== "APPROVE" && !reasonCode) return;
    await run(async () => {
      const response = await api(`/admin/verifications/${selected.id}/decision`, {
        method: "POST",
        headers: { ...securityHeaders(csrfToken), "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ decision, ...(reasonCode ? { reasonCode } : {}) }),
      });
      const updated = (await response.json()) as VerificationItem;
      setSelected(updated);
      setItems((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      clearMaterial();
      setMessage(`审核决定已记录：${updated.status}`);
    });
  }

  async function viewMaterial(assetType: "STUDENT_CARD" | "WECOM_SCREENSHOT") {
    if (selected === null) return;
    const reauthTotpCode = window.prompt("敏感操作：请再次输入 6 位动态验证码");
    if (!reauthTotpCode) return;
    await run(async () => {
      const issued = await api(`/admin/verifications/${selected.id}/asset-access`, {
        method: "POST",
        headers: { ...securityHeaders(csrfToken), "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ assetType, reauthTotpCode }),
      });
      const grant = (await issued.json()) as { grantToken: string };
      const consumed = await api("/admin/verification-assets/consume", {
        method: "POST",
        headers: {
          ...securityHeaders(csrfToken),
          "x-verification-asset-grant": grant.grantToken,
        },
      });
      clearMaterial();
      setMaterialUrl(URL.createObjectURL(await consumed.blob()));
      setMessage(
        `${assetType === "STUDENT_CARD" ? "学生卡照片" : "企业微信截图"}凭证已原子消费；关闭或刷新后必须重新验证。`,
      );
    });
  }

  async function rotateCsrf() {
    await run(async () => {
      const response = await api("/admin/auth/csrf", { method: "POST" });
      const body = (await response.json()) as { csrfToken: string };
      setCsrfToken(body.csrfToken);
      setMessage("请求保护令牌已轮换。旧令牌仅保留 30 秒并行窗口。 ");
    });
  }

  async function logout() {
    await run(async () => {
      await api("/admin/auth/logout", {
        method: "POST",
        headers: securityHeaders(csrfToken),
      });
      setCsrfToken("");
      setItems([]);
      setSelected(null);
      clearMaterial();
      setMessage("已安全退出。 ");
    });
  }

  function clearMaterial() {
    setMaterialUrl((current) => {
      if (current !== "") URL.revokeObjectURL(current);
      return "";
    });
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Campus Companion · M2</p>
          <h1>学生认证审核台</h1>
          <p className="summary">仅处理学生身份认证；不接入司机、车辆、运价、车费或运输订单。</p>
        </div>
        {csrfToken !== "" && (
          <div className="header-actions">
            <button type="button" onClick={() => void rotateCsrf()} disabled={busy}>
              轮换 CSRF
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => void logout()}
              disabled={busy}
            >
              退出
            </button>
          </div>
        )}
      </header>

      <aside role="status" aria-live="polite">
        {message}
      </aside>

      {csrfToken === "" ? (
        <form className="panel login" onSubmit={(event) => void login(event)}>
          <h2>管理员登录</h2>
          <label>
            账号
            <input name="username" autoComplete="username" minLength={3} maxLength={100} required />
          </label>
          <label>
            密码
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              minLength={12}
              maxLength={256}
              required
            />
          </label>
          <label>
            动态验证码
            <input
              name="totpCode"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              autoComplete="one-time-code"
              required
            />
          </label>
          <button type="submit" disabled={busy}>
            登录
          </button>
        </form>
      ) : (
        <>
          <section className="toolbar">
            <label>
              校区 ID
              <input
                value={campusId}
                onChange={(event) => setCampusId(event.target.value)}
                placeholder="UUID"
              />
            </label>
            <button
              type="button"
              onClick={() => void loadQueue()}
              disabled={busy || campusId === ""}
            >
              加载审核队列
            </button>
          </section>
          <section className="workspace">
            <div className="panel queue">
              <h2>脱敏队列</h2>
              {items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="queue-item"
                  onClick={() => {
                    setSelected(item);
                    clearMaterial();
                  }}
                >
                  <strong>学号后四位 {item.studentNumberLast4}</strong>
                  <span>{item.status}</span>
                </button>
              ))}
              {items.length === 0 && <p className="muted">当前没有已加载的申请。</p>}
            </div>
            <div className="panel detail">
              <h2>审核详情</h2>
              {selected === null ? (
                <p className="muted">请选择一条申请。</p>
              ) : (
                <>
                  <dl>
                    <dt>申请 ID</dt>
                    <dd>{selected.id}</dd>
                    <dt>学号</dt>
                    <dd>仅显示后四位：{selected.studentNumberLast4}</dd>
                    <dt>状态</dt>
                    <dd>{selected.status}</dd>
                    <dt>提交时间</dt>
                    <dd>{selected.submittedAt ?? "未提交"}</dd>
                    <dt>原因代码</dt>
                    <dd>{selected.reasonCode ?? "—"}</dd>
                  </dl>
                  <div className="actions">
                    {selected.availableAssetTypes.map((assetType) => (
                      <button
                        key={assetType}
                        type="button"
                        onClick={() => void viewMaterial(assetType)}
                        disabled={busy}
                      >
                        TOTP 查看{assetType === "STUDENT_CARD" ? "学生卡" : "企业微信截图"}
                      </button>
                    ))}
                    <button type="button" onClick={() => void review("APPROVE")} disabled={busy}>
                      通过
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => void review("REQUIRE_RESUBMISSION")}
                      disabled={busy}
                    >
                      要求补交
                    </button>
                    <button
                      type="button"
                      className="danger"
                      onClick={() => void review("REJECT")}
                      disabled={busy}
                    >
                      拒绝
                    </button>
                  </div>
                  {materialUrl !== "" && (
                    <img className="material" src={materialUrl} alt="一次性查看的学生认证材料" />
                  )}
                </>
              )}
            </div>
          </section>
        </>
      )}
    </main>
  );
}

function securityHeaders(csrfToken: string): Record<string, string> {
  return { "x-csrf-token": csrfToken };
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    credentials: "include",
    cache: "no-store",
    headers: { "content-type": "application/json", ...init.headers },
  });
  if (!response.ok) {
    let body: ApiErrorBody = {};
    try {
      body = (await response.json()) as ApiErrorBody;
    } catch {
      body = {};
    }
    const code = body.error?.code ?? `HTTP_${response.status}`;
    const requestId = body.error?.requestId ? `（请求 ${body.error.requestId}）` : "";
    throw new Error(`${code}: ${body.error?.message ?? "操作失败"}${requestId}`);
  }
  return response;
}
