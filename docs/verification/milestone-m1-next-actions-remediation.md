# M1 下一步行动整改记录

日期：2026-07-15（Asia/Shanghai）

状态：**PARTIAL；M1 继续 BLOCKED，不得进入 M2**

## 2026-07-31 后续验证更新

- A-04/A-05：GitHub Actions 运行 `30619545281` 已完成 PostgreSQL 16.8 首次部署、二次幂等
  部署和 `prisma migrate status`，全部成功。
- A-06/A-07：4 个原生 PostgreSQL 测试和 1 个原生 Redis 7.4.2 测试均为零跳过、零失败。
- A-08：同一绿色运行的依赖审计所有严重级别均为 0。
- A-02：工作区、本机、GitHub 仓库和 CI 历史数据库技术清点已完成；仓库外云账号、其他设备
  和离线备份仍需负责人声明，详见 `m1-github-ci-and-environment-inventory.md`。
- A-09：负责人已批准仓库公开；`main` 已要求 PR、严格的 GitHub Actions `verify`、管理员执行、
  解决会话、线性历史，并禁止强推和删除。状态改为 `COMPLETE`。
- A-02/A-03：Cedric 已完成仓库外数据库范围声明并签署空库基线批准；未发现需删除数据库。
- A-10：`migration-release-baseline.sha256` 已生成；本最终化变更必须通过受保护 PR 后才生效。

以下正文保留 2026-07-15 整改当时的历史状态，不得覆盖上述更新。

## 输入证据

- 外部行动清单：`m1-next-actions.md`
- `SHA-256(raw-bytes)`：`17f890c04e99d49dda735b5f1f8e0f7ccad97262bc0c5eb0d7a31d832c260041`
- 本记录仅落实能够在当前工作区安全完成的工程整改；不替项目/发布负责人声明外部环境不存在，也不伪造受保护 CI 结果。

## 已完成整改

### 1. CI 供应链锁定

四个第三方 GitHub Action 已由发布标签改为完整提交 SHA，并保留版本注释：

| Action | 版本 | 完整提交 SHA |
|---|---|---|
| `actions/checkout` | `v4.2.2` | `11bd71901bbe5b1630ceea73d27597364c9af683` |
| `pnpm/action-setup` | `v4.1.0` | `a7487c7e89a18df4991f7f222e4898a00d66ddda` |
| `actions/setup-node` | `v4.4.0` | `49933ea5288caeca8642d1e84afbd3f7d6820020` |
| `actions/upload-artifact` | `v4.6.2` | `ea165f8d65b6e75b540449e92b4886f43607fa02` |

提交 SHA 通过 GitHub 官方仓库的 commit/tag API 核对。checkout 已设置 `persist-credentials: false`。

新增 `.github/dependabot.yml`，每周对 GitHub Actions 依赖更新发起独立审查；这不代表自动合并更新。

### 2. 可审计 CI 证据

工作流现会分别保存：

- 仓库、提交、工作流、运行编号、Runner、Node、pnpm、PostgreSQL 和 Redis 版本；
- 精确依赖安装及锁文件未变化断言；
- 首次迁移、第二次迁移和迁移状态完整日志；
- 全量 `pnpm check` 日志；
- 原生 PostgreSQL 与 Redis 的 Vitest JSON；
- 在线依赖审计 JSON；
- 每一步的 GitHub outcome；
- 所有证据文件的 `SHA-256(raw-bytes)` 清单。

无论前序步骤成功还是失败，证据清单和产物上传均使用 `if: always()`；缺少产物会报错，保留期为30天。

### 3. 原生测试不得静默跳过

新增 `tools/assert-native-vitest-report.mjs`。它要求：

- PostgreSQL 至少执行4个原生测试，Redis 至少执行1个原生测试；
- 测试套件和测试的失败、跳过、待定、todo 数量均为0；
- 所有套件和断言都显式通过。

本地对该断言进行了正反两次验证：全通过报告退出码为0；含4个跳过测试的报告退出码为1并明确拒绝。

### 4. 本地门禁与在线审计

| 检查 | 结果 |
|---|---|
| `pnpm check` | PASS |
| `verify:m0` | 343/343 |
| `verify:m1` | 301/301 |
| 本地测试 | 37 passed；5 个原生依赖测试因本机无服务而 skipped |
| API 覆盖率 | Statements 100%、Branches 88.63%、Functions 100%、Lines 100% |
| Domain 覆盖率 | 四项 100% |
| `pnpm audit --audit-level high --json` | PASS；info/low/moderate/high/critical 均为0 |

本地在线审计完成 A-08 的工作区验证，但 A-08 的最终完成仍需要受保护 CI 在同一受审提交上重新运行并保存产物。

## 文件摘要

| 文件 | `SHA-256(raw-bytes)` |
|---|---|
| `.github/workflows/ci.yml` | `466902d3c0ee161b86a8624fde6bf992763ca9c6785fda3be23f8b44adc6dc46` |
| `.github/dependabot.yml` | `16e5df1f943b2c4f848fc1ad26e05577cedd72fffff796c508ff239923742e7f` |
| `tools/assert-native-vitest-report.mjs` | `7c2427983b1ff95665bca14f609bc403de0c573da70814f530ff8af19efcf2a8` |
| `tools/verify-m1.ps1` | `d21793900d1c1b536329b3d4893c8b840a51ac12e898155089cfa958defb34f1` |
| `docs/verification/m1-baseline.sha256` | `cd95041a91736be333ea6cf3973c36bc67ff4880ead622d159588f1cf026749b` |

这些是当前工作区候选摘要，不是最终受保护信任根。最终证据必须绑定远程仓库完整提交 SHA 和不可共同修改的 CI 运行。

## 仍然阻断的行动

| 行动 | 当前状态 | 原因/下一步 |
|---|---|---|
| A-01 M0 重新确认 | PENDING | 需要用户在最新复核后明确确认，并将记录绑定受保护提交或其他不可共同修改位置 |
| A-02 外部环境清点 | COMPLETE | 技术清点与 Cedric 负责人范围外声明均已完成，无旧 M1 数据保留义务 |
| A-03 重置范围审批 | COMPLETE | Cedric 同时作为项目/发布负责人和最终批准人签署，停止部署联系人为 Cedric |
| A-04/A-05 原生迁移与状态 | PENDING | 当前主机无 PostgreSQL/Git/Docker；需受保护 CI |
| A-06 原生 PostgreSQL 测试 | PENDING | 用例已实现，尚无0跳过的原生运行证据 |
| A-07 原生 Redis 测试 | PENDING | 用例已实现，尚无0跳过的原生运行证据 |
| A-08 在线依赖审计 | LOCAL PASS / CI PENDING | 本地已刷新为全0，仍需受保护 CI 产物 |
| A-09 受保护 CI 信任根 | COMPLETE | 公开仓库 `main` 已启用管理员执行的 PR、严格 `verify`、线性历史、会话解决、禁强推/删除 |
| A-10 冻结迁移与 M1 PASS | IN PROGRESS | 发布摘要已生成，等待本变更通过受保护 PR 与主分支 CI |
| A-11 用户确认 M1 | PENDING | 受保护最终化完成后暂停，等待用户显式确认，不自动开始 M2 |

## 负责人必须提供的信息

继续前需要项目/发布负责人：

1. 明确重新确认 M0 技术 PASS；
2. 在 `m1-database-reset-decision.md` 中填写全部外部环境、负责人、检查方式、日期、结果和数据保留义务，并签署决定；
3. 提供私有或受控 GitHub 仓库标识及允许推送的授权，随后启用默认分支保护、必须通过 `quality-gates`、限制工作流和验证基线修改权限。

任何环境发现旧迁移或需保留数据时，立即停止重置与冻结，改为设计前向收敛迁移。
