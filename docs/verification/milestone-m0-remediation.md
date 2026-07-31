# M0 独立复核修复验证报告

状态：**BLOCKED（修复已实现并通过本地门禁，等待独立复核与用户重新确认）**

## 范围与基线

- 修复来源：2026-07-14《Campus Companion M0 架构基线独立审查》。
- 原 `milestone-m0.md` 已改为历史 FAIL，不再作为进入后续里程碑的证据。
- 当前不可变文件集合记录于 `m0-baseline.sha256`；验证脚本同时校验文件存在和 SHA-256，任一核心文件变化都会使门禁失败。
- 当前目录仍不是 Git 仓库，因此没有提交 SHA；摘要基线在此阶段代替提交绑定，但不能替代后续 Git/CI 证据。

## 阻断项关闭情况

| 审查项 | 修复 | 自动断言 |
|---|---|---|
| B-01 退款过渡态缺失 | Group 新增 `REFUNDING`/`REFUND_RETRY`；补偿期间禁止加入、离开、新轮、下单、解锁和读取；全部退款后才移除成员并重算 | 领域状态/映射检查、OpenAPI 枚举、Prisma 枚举、迁移链和数据库负向测试 |
| B-02 同意/解锁/读取混合 | 轮次锁定成员摘要和政策版本；结构化 ACCEPT；新增撤回接口；`ContactUnlock` 与追加式 `ContactAccessLog` 分离 | 版本字段/条件 Schema、撤回 operation、访问日志双写和 DENIED 约束测试 |
| B-03 待上传认证态缺失 | 增加 `AWAITING_UPLOAD` 与 `REQUIRE_RESUBMISSION`；待上传时 `submittedAt=null`；对象校验后才能 PENDING | OpenAPI `oneOf`、Prisma/迁移状态、契约语义检查 |
| B-04 管理员敏感流程不可执行 | 明确安全 Cookie/CSRF 轮换；增加脱敏审核读取、TOTP 再认证、短时单次材料凭证；operation 级角色/校区元数据 | OpenAPI 路径/扩展/错误矩阵、AdminSession/Grant 模型和数据库生命周期约束 |

## 应改项关闭情况

- M-01：校区和路线目录均显式 `security: []`；只返回已启用低敏感目录，不包含个体供需数据。
- M-02：幂等分为客户端业务写、认证令牌族和微信回调三类；验证脚本逐 operation 检查。
- M-03：所有受保护 operation 显式声明 401；归属失败使用防枚举 404；ErrorDetails 关闭任意属性，只允许白名单字段。
- M-04：新增 SHA-256 文件基线；旧报告保留为 FAIL；固定版本 OpenAPI 语义 lint 纳入 `pnpm check`。

## 产品决策

- 解锁前撤回同意：不交付，本轮进入全额退款补偿。
- 已付款但解锁前撤回：同上，所有本轮已付款订单退款。
- 解锁后撤回：立即阻止该用户作为查看者或被查看者的后续读取；已经展示到其他成员设备的明文无法技术性收回，已写入政策与页面规则。

## 已执行证据

- `pnpm api:lint`：OpenAPI 3.1 解析和语义检查通过，0 错误、0 警告。
- `pnpm verify:m0`：结构化语义、operation 级鉴权/幂等和摘要基线检查通过。
- Prisma validate/generate：修复后的 Schema 有效并可生成 Client。
- PostgreSQL 兼容引擎：空库迁移链通过；另从含认证材料和成团轮次数据的原 M1 快照升级，`DRAFT` 正确变为 `AWAITING_UPLOAD`，上传期限和本轮共享政策版本完成回填。
- `pnpm check`：PASS。M0 结构/语义/摘要检查 272 项，M1 工程检查 172 项；类型、Lint、构建、Prisma、静态安全和覆盖率门槛全部通过。
- 测试：32 个通过，3 个原生依赖测试因本机环境门禁跳过；API Statements/Functions/Lines 100%，Branches 88.63%；Domain 当前 M1 基线 100%。
- `pnpm audit --audit-level high`：未发现已知漏洞。

## 残余风险与门禁

- 修复者不能把自己的复核称为“独立复核”。需要重新由独立审查者核对当前摘要基线后，M0 才能改判 PASS。
- M1 的原生 PostgreSQL 16 与 Redis 7 门禁仍因本机缺少运行环境而 BLOCKED；PGlite 证据不能替代原生门禁。
- 正式收费前仍需专业法律、微信类目、支付、税务、退款和隐私审阅。
- 在独立复核、用户重新确认 M0 和 M1 原生门禁全部完成前，不开始 M2。
