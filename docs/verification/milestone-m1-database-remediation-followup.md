# M1 数据库整改第二轮验证报告

日期：2026-07-15（Asia/Shanghai）
状态：**BLOCKED；不得进入 M2**

## 复核输入

本轮依据独立复核 `m1-database-remediation-review.md` 整改。收到的复核文件 SHA-256 为：

`7926ac20737cd95946ef56809c84503f52ea79e3bb2eaeaf86de3716ab9753c5`

独立复核结论为：F-02 已关闭；F-01 仅条件关闭；新增 DB-01 原生迁移风险和 DB-02 负责人/环境审批缺口。

## 整改结果

| 项目 | 当前结果 | 证据边界 |
|---|---|---|
| F-02 认证有效期 | 保持关闭 | ADR-014、互斥 OpenAPI 分支、数据库状态—时间 CHECK、领域边界测试均未回退 |
| DB-01 最终态空库候选 | 本地整改完成，仍待原生验收 | 迁移由 Prisma 6.19.2 `from-empty` 生成最终基础结构，只追加 Schema 无法表达的数据库对象 |
| DB-01 历史升级步骤 | 已移除 | 候选不含 `ALTER TYPE`、`ADD COLUMN`、旧值重命名、数据回填或前序迁移假设 |
| DB-01 候选指纹 | 已记录但未冻结 | `migration-candidate.sha256` 明确不是批准或不可变发布基线 |
| DB-02 环境清单 | 未完成 | 当前工作区和主机已清点；共享开发、测试/预发布、CI、云账号、其他开发者和备份仍为 `UNKNOWN` |
| DB-02 负责人批准 | 未完成 | 决策提出者不具备发布批准权；项目/发布负责人、批准人、时间和停止部署联系人仍待填写 |

## 最终态候选构造

候选目录为 `20260715000000_m1_final_state_candidate`。生成与审查顺序：

1. 使用最终 `schema.prisma` 从 empty 直接生成基础 SQL；
2. 直接创建最终 `VerificationStatus`、`GroupState` 和其他枚举；
3. 追加复合校区外键、CHECK、部分唯一索引、座位容量触发器、材料 Grant 原子消费函数及政策种子；
4. 用结构门禁拒绝历史升级语句和空库回填；
5. 在 PGlite 空库执行候选并通过 `pg_catalog` 清点关键对象。

候选 SHA-256：

`8c18d49b24f57531ebad3fdad57d626adcd53a8d60116c17bd23527626a093f7`

该摘要只证明本轮被测试的候选字节，不能替代负责人批准，也不能替代 Prisma 在 PostgreSQL 16.8 上的迁移历史与 checksum 验证。

## 新增或强化的门禁

- Schema 测试确认最终枚举被直接创建，并拒绝 `ALTER TYPE`、`ADD COLUMN`、历史注释和空库回填。
- PGlite E2E 清点最终枚举、关键 CHECK/FK、三个函数和两个触发器。
- CI 顺序固定为首次 `prisma migrate deploy`、第二次 `deploy`、`prisma migrate status`，随后才运行完整质量门禁。
- `verify:m1` 要求候选迁移唯一、候选摘要匹配、重置状态为 `PENDING APPROVAL`、外部环境保留 `UNKNOWN` 且批准签名不得伪造。
- 若发现任何旧持久数据库，ADR-013 自动否决重置路线并要求前向收敛迁移。

## 本地复验结果

| 检查 | 结果 |
|---|---|
| 数据库专项测试 | PASS，11 项；3 项原生 PostgreSQL 用例按环境门禁跳过 |
| `pnpm verify:m0` | PASS，329/329 |
| `pnpm verify:m1` | PASS，255/255 |
| 完整 `pnpm check` | PASS；OpenAPI、格式/Lint、静态安全、类型、测试、覆盖率、构建、Prisma 校验和摘要一致 |
| 全工作区测试 | PASS，37 项；4 项原生 PostgreSQL/Redis 用例按环境门禁跳过 |
| API 覆盖率 | Statements 100%、Branches 88.63%、Functions 100%、Lines 100% |
| Domain 覆盖率 | Statements/Branches/Functions/Lines 均为 100% |
| 联网依赖审计 | 本轮未刷新；必须由受保护 CI 再次执行 |

这些 PASS 只覆盖本机可执行门禁。跳过的原生用例、环境审批和联网审计仍是 M1 阻断项，不能用 PGlite 或文本断言替代。

## 尚未完成的验收

1. 项目/发布负责人逐项清点所有外部数据库环境并签署重置范围；
2. PostgreSQL 16.8 首次部署、第二次幂等部署和 `migrate status`；
3. PGlite 与原生 PostgreSQL 的关键对象清单一致性；
4. 原生 PostgreSQL 并发测试、Redis/BullMQ 测试和备份/恢复证据；
5. 联网依赖审计与受保护 CI 完整执行。

在上述证据齐全前，候选不得改称“冻结基线”，M1 保持 BLOCKED，M2 不得开始。
