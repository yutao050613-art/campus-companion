# M1 迁移历史与认证有效期整改报告

状态：**BLOCKED（F-01/F-02 已本地修复；等待原生依赖门禁、独立复核与用户确认）**

## 修复范围

| 问题 | 处理 | 主要证据 |
|---|---|---|
| F-01 已存在迁移被原地改写 | 确认尚无持久数据库；退役三个预发布迁移，合并为唯一 `20260714030000_m1_frozen_baseline`；新增独立迁移摘要和重置决定 | ADR-013、`m1-database-reset-decision.md`、`migration-baseline.sha256`、空库 PGlite 执行 |
| F-02 `expiresAt` 语义不唯一 | 禁止永久认证；四个审核结果使用独立 OpenAPI 分支；`VERIFIED`/`VERIFICATION_EXPIRED` 要求非空有效期且晚于审核时间；同步授权在边界拒绝 | ADR-014、数据库 CHECK、领域边界/重放/乱序测试 |

## 关键安全语义

- 旧 M1 数据库不得直接应用新基线；若存在必须删除重建。未来发现未披露持久库时立即停止部署并设计前向收敛。
- 冻结迁移 SQL 的任何字节变化都会使摘要门禁失败；今后的结构变化只能追加新迁移。
- `expiresAt` 刚好等于事务时间即失效；业务授权不依赖异步任务及时更新状态。
- 过期任务只允许 `VERIFIED -> VERIFICATION_EXPIRED`，重复或旧任务乱序执行不得恢复终态。

## 本地证据

- PGlite 冻结基线空库执行：PASS。
- 数据库测试：9 个通过，3 个原生 PostgreSQL 用例因环境门禁跳过。
- Domain 测试：4 个通过，覆盖未到期、精确边界、到期后、空值、非法时间、重复与乱序。
- OpenAPI 3.1 lint：PASS，0 错误、0 警告。
- 完整 `pnpm check`：PASS；类型检查、格式、静态安全扫描、测试、覆盖率、构建、Prisma 和结构门禁均通过。
- 全工作区测试：35 个通过；4 个原生依赖用例按环境门禁跳过。
- 核心 API 覆盖率：Statements 100%、Branches 88.63%、Functions 100%、Lines 100%；Domain 四项均为 100%。
- `pnpm verify:m0`：325 项通过，0 失败。
- `pnpm verify:m1`：240 项通过，0 失败。
- 本轮没有联网刷新依赖公告库；锁文件未变化，受保护 CI 仍须运行 `pnpm audit --audit-level high`。

## 剩余阻断

- 原生 PostgreSQL 16 的 `prisma migrate deploy/status`、座位与 Grant 20轮并发尚未执行。
- 原生 Redis 7/BullMQ 集成尚未执行。
- 受保护 CI 的实时依赖公告审计尚未刷新。
- 用户尚未根据独立报告重新确认 M0；M1 也未确认。
- M2 未开始。
