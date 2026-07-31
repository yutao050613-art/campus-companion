# M3 免费组队闭环验证报告

状态：**本地门禁通过，等待受保护 GitHub PR 的 M3 CI 证据；未进入 M4**

- 验证日期：2026-08-01（Asia/Shanghai）
- 负责人及最终批准人：Cedric
- 进入基线：`9e8ef667a43c526a21d2505eff22adb0c83cf978`
- 范围：固定路线、发布需求、候选组、加入/退出、2—4 座位、至少两个认证账号、成团确认、超时与小程序页面

## 交付结论

M3 已完成免费组队闭环，并停在 M4 的明确边界：最后一名成员确认后，组与轮次只进入
`PAYING`/`PAYMENT_PENDING`，不创建服务订单、支付交易、退款或联系方式解锁记录。

核心规则已经同时落实在领域函数、API 串行化事务、既有数据库约束和原生 PostgreSQL 测试中：

- 单账号可占 1—3 个座位，总座位最多 4 个；
- 只有至少两个不同的有效认证账号才能进入 `READY`；
- 同一用户不能同时占用时间重叠的有效组；
- 组成员、路线、认证资格、同性偏好和快照在关键写入中重新读取；
- 候选组只返回组内匿名标签，不返回账号 ID、自报性别、微信号或认证材料；
- 确认轮次锁定成员快照与联系方式共享政策版本；
- 拒绝或超时使轮次失效，迟到 Worker 不会回退 `PAYING`；
- 客户端不能提交可信组状态、付款状态或价格。

## 自动验证结果

| 门禁 | 本地结果 |
|---|---|
| OpenAPI 3.1 校验 | PASS，0 错误 |
| Biome 格式与 Lint | PASS，0 错误/警告（仅信息级建议） |
| 自定义静态安全扫描 | PASS，49 个源文件、0 违规 |
| TypeScript strict | PASS，全部工作区 |
| Prisma validate/generate | PASS |
| 全量构建 | PASS |
| 单元与本地 E2E | PASS，140 项通过；14 项原生依赖测试在普通门禁中按设计跳过 |
| `pnpm verify:m0` | PASS |
| `pnpm verify:m1` | PASS，319 项 |
| `pnpm verify:m2` | PASS，98 项 |
| `pnpm verify:m3` | PASS（基线生成后复跑） |
| `pnpm audit --audit-level high` | PASS，未发现已知漏洞 |

普通门禁中的原生依赖测试只允许跳过，不能据此声称原生验证通过。以下测试已另外在本地 Docker
PostgreSQL 16.8 上显式启用，并将在独立 M3 CI 中用 JSON 结果数量断言防止静默跳过：

| 原生测试 | 结果 | 关键证据 |
|---|---:|---|
| M3 API | 5/5 PASS | 最后一座竞争 20 轮；重叠组竞争 20 轮；四人并发确认 20 轮；拒绝补偿；完整隐私边界 |
| M3 Worker | 1/1 PASS | 确认超时、重复执行、`PAYING` 保护、过期候选组关闭 |

## 覆盖率

| 范围 | Statements | Branches | Functions | Lines |
|---|---:|---:|---:|---:|
| API | 91.51% | 80.31% | 97.98% | 93.95% |
| Domain | 100% | 100% | 100% | 100% |

API 四项硬门槛为 80%，领域四项硬门槛为 90%；本次均通过。Worker 的关键超时转换由独立单元测试
和真实 PostgreSQL 测试验证，M3 尚未把整个历史 Worker 应用纳入全局覆盖率硬门槛。

## 原生并发与失败验证

1. 两个请求连续 20 轮竞争第四个座位，每轮恰好一个成功、一个稳定冲突；数据库最终始终为 4 个不同账号、4 个座位。
2. 同一账号连续 20 轮并发转移到两个时间重叠的目标组，每轮最多保留一个有效成员关系。
3. 四名成员连续 20 轮同时确认；每轮四个请求均成功、仅一个事务完成 `PAYING` 转换，确认与同意各恰好 4 条。
4. 对错误政策版本的确认在写入确认或同意记录前失败。
5. 拒绝会使轮次失效、移除拒绝者、重新开放其需求并重算剩余组。
6. 超时 Worker 通过条件更新获得转换资格；重复运行为空操作，且不能改变已经进入 `PAYING` 的轮次或组。
7. 组详情原始响应扫描确认不存在 `wechat`、`contact`、`userId` 或 `gender`；M3 数据库中服务订单、支付、退款和联系方式解锁均为零。

## 对抗性复核发现与修复

### 四人并发确认可能耗尽三次重试

首次攻击者视角测试让四名成员同时确认，发现前三个事务依次提交时，最后一个事务可能恰好连续发生三次
PostgreSQL 串行化冲突，最终暴露为 500。修复保留历史 M2 默认三次重试，并为 M3 四人确认显式配置最多
五次尝试，同时在每次冲突后执行有界指数随机退避；配置上限被固定为八次。随后连续 20 轮四人并发确认全部通过。

### 满座组过滤可能破坏游标分页

候选组列表需要隐藏已满四座的组。最初实现先取 21 行再过滤，可能在一页存在大量满座组时返回过少结果或跳过
后续可加入组。现改为每页 20 条、最多扫描 5 批的有界游标扫描，并通过跨满座批次和下一页游标测试。

本地第二轮复核未发现 P0/P1 缺陷。该结论不替代受保护 CI、微信开发者工具真机测试、正式渗透测试或
个人信息保护专业审查。

## 数据库与迁移

- M3 不新增迁移，复用已验收的 M1 最终模型与 M2 敏感材料扩展。
- M1 迁移 SHA-256 仍为 `6d893aa089650d72b717546960679aad1f3f61abe8b32ba07ed2a623ad605902`。
- M2 迁移 SHA-256 仍为 `fb8e9e49d97db759d8eb441ff2f89e6dd54c13e3a4bb35eab350c4f807e5a681`。
- 空库迁移与重复 `migrate deploy` 将由 M3 CI 再次执行并保存原始日志。

## 独立 CI 与证据 Artifact

`.github/workflows/m3-quality.yml` 使用固定版本的 PostgreSQL 16.8、Redis 7.4.2、Node 22.22.0 和
完整提交 SHA 固定的 GitHub Actions。它将执行：

- 精确锁文件安装与锁文件完整性检查；
- 空库迁移、重复迁移和迁移状态；
- `pnpm check` 全量门禁；
- 原生 PostgreSQL 清单、历史 M2 API、M3 API、M3 Worker 和 Redis 数量断言；
- 高危依赖审计；
- 原始日志、JSON 报告、步骤结果和逐文件 SHA-256 清单；
- 30 天保留的 `m3-verification-*` Artifact。

PR 创建后必须补录运行 ID、提交 SHA、Artifact ID、下载后摘要与内部清单复算结果。在这些证据通过前，
M3 不能被标记为最终验收，也不能开始 M4。

## 残余风险与非目标

- 微信登录仍是严格限定于 development/test 的签名 Mock；真实微信登录不属于 M3。
- 尚未进行微信开发者工具和真机交互验收；当前小程序门禁为 TypeScript、契约和构建检查。
- M3 不包含订单、模拟支付、微信支付、退款、联系方式公开、举报、拉黑、司机、车辆、运价、定位或运输履约。
- 当前 `PAYING` 只是 M4 的输入状态；M4 必须实现付款超时移除、已付款全轮退款和重新确认，不能直接解锁联系方式。
- 生产 COS/KMS、腾讯云部署、监控、备份恢复和故障演练属于后续里程碑。

## 最终验收条件

1. 将 M3 变更通过 Pull Request 提交到受保护的 `main`；
2. 原有 `quality-gates` 与新增 `m3-quality-gates` 均通过；
3. 保存并复算 M3 证据 Artifact 的 SHA-256 清单；
4. 将受保护 CI 证据补录到本报告并再次通过门禁；
5. 由 Cedric 明确确认 M3 验收通过；确认前暂停，不开始 M4。

## CI-native-suite isolation remediation

The first protected M3 CI attempt exposed a test-harness race rather than a product
defect: native PostgreSQL API test files concurrently reset the same test database.
The remediation serializes *test files only* when `NATIVE_POSTGRES_TESTS=true`; the
intentional request-level concurrency races remain in the native M2/M3 tests. The
health API test now also creates and removes a dedicated temporary object-store
directory, preventing it from reading a developer-machine path.

The complete CI-equivalent command passed locally with native PostgreSQL and Redis
enabled after this remediation. The final protected-CI run ID, artifact ID, and
downloaded SHA-256 manifest verification will be recorded here before M3 is proposed
for final acceptance.
