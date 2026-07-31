# M1 原生数据库对象清点整改报告

日期：2026-07-15（Asia/Shanghai）
状态：**代码整改完成；原生执行仍待完成，M1 保持 BLOCKED**

## 复核输入

本轮依据《Campus Companion M1 数据库整改第二轮独立复核》处理 R-01 与 R-02。收到的复核文本 SHA-256 为：

`fae941dcdcb6a4b53a6e7773c002ff9de53ee36edddbbf5d6afd452f736a4aeb`

复核确认 DB-01 本地候选成立、DB-02 正确保留待审批，同时指出原生 PostgreSQL 测试尚未实现报告中声称的 `pg_catalog` 对象清点。

## R-01 整改

新增 `database-object-inventory.ts` 作为 PGlite 与原生 PostgreSQL 的唯一共享期望源，固定：

- `VerificationStatus` 九个枚举值及顺序；
- `GroupMember`、`ServiceOrder` 的基础/复合校区外键；
- 认证状态—时间、联系方式披露和材料 Grant 生命周期约束；
- 座位容量与 Grant `usedAt` 不可变触发器；
- 座位校验、Grant 防重放和 Grant 原子消费函数。

共享 SQL 使用 `pg_enum`、`pg_constraint`、`pg_proc` 和 `pg_trigger`，并按受监控对象范围查询完整集合后精确比较。这样缺少对象、出现范围内额外对象或名称漂移都会失败。

`migration.e2e.test.ts` 与 `native-postgres.e2e.test.ts` 现在引用同一查询和同一期望。CI 已设置 `NATIVE_POSTGRES_TESTS=true` 并运行完整 `pnpm check`，因此在 PostgreSQL 16.8 服务可用时会实际执行该原生清点，而非仅检查报告文字。

本地第一次复验因共享清单遗漏 `GroupMember_campusId_fkey` 和 `ServiceOrder_campusId_fkey` 而失败，证明额外对象检测有效；补入两项应保留基础外键后，数据库专项测试通过。

## R-02 整改

候选头部已澄清：

- 在负责人审批和原生门禁完成前，不得冻结或部署到共享、持久或发布环境；
- 允许在一次性、隔离数据库中执行候选验收。

该措辞不授权生产或共享环境部署，也不会把验证部署误判为禁止行为。

## 本地验证边界

- 数据库专项测试：PASS，11 项；4 项原生 PostgreSQL 测试因本机无环境跳过。
- 完整 `pnpm check`：PASS；全工作区 37 项通过，5 项原生 PostgreSQL/Redis 测试按环境门禁跳过。
- `verify:m0`：333/333；`verify:m1`：275/275。
- PGlite 已使用共享清单查询并精确验证对象集合。
- 原生测试实现、TypeScript 编译与 CI 路由可由本地检查证明，但 PostgreSQL 16.8 上的实际查询结果尚无本轮证据。
- DB-02 负责人审批、原生 Redis、在线依赖审计和受保护 CI 仍未完成。

因此 R-01 的“实现缺口”已修复，但其原生执行证据仍属于 M1 PASS 前门禁。不得据此冻结迁移或开始 M2。

本轮迁移候选 SHA-256：

`6d893aa089650d72b717546960679aad1f3f61abe8b32ba07ed2a623ad605902`
