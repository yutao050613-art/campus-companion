# M0 第二轮独立复核修复验证报告

状态：**BLOCKED（修复已实现并通过本地门禁，等待独立复核与用户重新确认）**

## 范围

- 修复来源：2026-07-14《Campus Companion M0 修复与 M1 基线独立复核》。
- 本报告关闭 R-01、R-02，并同步处理 M1 的 R-03、R-04 与审计优化 R-05。
- R-06 无法仅靠同一工作区内的摘要文件完全关闭；新增 M1 摘要清单降低漂移风险，但目录仍不是 Git 仓库，最终信任根必须由新的独立报告记录清单摘要，或后续使用受保护 Git/CI 签名。
- M2 未开始。

## 修复结论

| 复核项 | 修复 | 自动证据 |
|---|---|---|
| R-01 认证过期和补交无法无损表达 | `UPLOAD_EXPIRED` 与 `VERIFICATION_EXPIRED` 分离；补交经过 `RESUBMISSION_AWAITING_UPLOAD`/`RESUBMISSION_PENDING`；增加 `latestSubmittedAt`，不清空首次提交和上次审核时间 | OpenAPI 互斥 `oneOf`、Prisma enum、状态—时间 CHECK、非法组合负向测试 |
| R-02 Grant 无消费契约 | 返回独立 `grantToken` 和固定代理路径；凭证只进专用请求头；绑定管理员会话/校区/申请/对象；数据库条件更新原子消费并写审计；不重定向或返回 COS URL | 60秒 CHECK、`usedAt` 不可变触发器、消费函数、重放/超长寿命测试、原生20轮并发测试代码 |
| R-03 政策硬编码 UUID | 按 `(type, version)` 解析实际政策 ID；摘要相同复用任意 UUID，摘要不同以约束错误安全失败 | 两类含数据升级测试 |
| R-04 状态与时间不一致 | PostgreSQL 强制每种认证状态的 `submittedAt/latestSubmittedAt/reviewedAt` 合法组合 | PENDING 缺时间、AWAITING_UPLOAD 带时间均被拒绝 |
| R-05 披露范围不可证明 | 联系方式读取采用整组全有或全无；成功日志锁定政策版本、被披露账号集合摘要和数量 | AccessLog v2 数据库约束、契约和政策断言 |
| R-06 摘要不是独立信任根 | 更新 M0 清单，并新增覆盖工程、迁移和安全证据的 M1 清单 | `verify:m0`/`verify:m1` 自动校验每个文件摘要；仍等待外部锚定 |

## 安全语义

- 首次上传凭证过期从未提交，因此 `submittedAt/latestSubmittedAt/reviewedAt` 全为空。
- 认证资格到期只发生在已审核记录上，历史提交和审核时间均保留。
- 补交成功只推进 `latestSubmittedAt`；不把旧申请伪装成首次待上传。
- 材料凭证流式读取中途失败仍视为已消费，管理员必须重新 TOTP 认证签发，避免开放重放窗口。
- 无效、过期、已用、错会话、错校区或对象已删除统一防枚举失败。
- 任一成员解锁后撤回，所有成员对该轮次的后续联系人读取整体失败；不返回过滤后的部分联系人。

## 已执行证据

- 完整 `pnpm check`：PASS；类型检查、Biome、静态安全扫描、构建、测试、覆盖率、OpenAPI、Prisma 与 M0/M1 结构门禁全部通过。
- Redocly OpenAPI 3.1 lint：PASS，0 错误、0 警告。
- Prisma format/validate/generate：PASS。
- 全工作区测试：35 个通过；4 个原生依赖用例因本机没有 PostgreSQL/Redis 而按门禁条件跳过。
- PGlite 迁移与数据库负向测试：12 个通过；其中覆盖策略 UUID 兼容回填、状态—时间约束、Grant 原子消费/重放/寿命/不可变性与旧快照升级。
- 核心 API 覆盖率：Statements 100%、Branches 88.63%、Functions 100%、Lines 100%；Domain 四项均为 100%。
- `pnpm verify:m0`：PASS，301 项。
- `pnpm verify:m1`：PASS，219 项。
- 本轮未联网刷新依赖公告库；锁文件和依赖图未改变，受保护 CI 仍必须重新执行 `pnpm audit --audit-level high`。

## 残余门禁

- 修复者不能将自己的审查称为独立复核；当前 M0 仍为 BLOCKED。
- 原生 PostgreSQL 16 的三段迁移、旧快照升级、座位并发与材料 Grant 20轮并发尚未执行。
- 原生 Redis 7/BullMQ 集成尚未执行。
- 依赖公告库需要在获准联网的受保护 CI 中刷新；锁文件和已固定 override 不能替代实时公告审计。
- 在独立复核、用户重新确认 M0 和 M1 原生门禁全部通过前，不开始 M2。
