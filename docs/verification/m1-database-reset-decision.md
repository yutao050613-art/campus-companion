# M1 预发布数据库重置决定

日期：2026-07-31（Asia/Shanghai）

状态：**TECHNICAL INVENTORY COMPLETE；OWNER ATTESTATION PENDING；不得执行重置或冻结迁移**

决策提出人：Codex（仅整理技术方案，不具备发布批准权）
项目/发布负责人：**待填写**
最终批准人：**待填写**
批准时间：**待填写**
停止部署联系人：**待填写**

机器可验证审批字段：

- `ProjectReleaseOwner: PENDING`
- `FinalApprover: PENDING`
- `ApprovalSignature: PENDING`

## 事实清点

- 项目尚未进入 M2，没有认证、组队或支付业务服务部署。
- 工作区只有 `.env.example` 与 CI 占位连接，没有真实环境 `.env`、数据库凭据或部署记录。
- 当前机器安装了 Docker CLI `29.6.1`，但 daemon 未运行；未发现 Docker 数据 VHD、WSL 发行版、
  PostgreSQL/Redis 程序、服务、进程或 `5432`/`6379` 监听端口。
- GitHub 仓库没有 Environments、Deployments、Actions Secrets 或 Actions Variables，只有一个协作者。
- GitHub Actions 运行 `30619545281` 已在随 Job 销毁的 PostgreSQL 16.8 与 Redis 7.4.2
  服务容器中通过全部原生门禁；证据 Artifact 不含数据库 dump、卷或快照。
- `docs/verification/m1-github-ci-and-environment-inventory.md` 固化了本轮命令、API 和 Artifact 证据。
- 上述事实不能证明未连接到本项目的云账号、其他电脑或离线备份中绝对不存在数据库。

## 环境清单

| 环境 | Owner | 检查方式 | 检查时间 | 结果 | 数据保留义务 |
|---|---|---|---|---|---|
| 当前工作区 | Codex 本地检查 | 搜索真实 `.env`、部署记录和数据库文件 | 2026-07-31 | `CONFIRMED_NO_PERSISTENT_DB` | 未发现 |
| 当前 Windows 主机 | Codex 本地检查 | 工具、服务、进程、端口、WSL、Docker 数据盘和常见数据目录 | 2026-07-31 | `CONFIRMED_NO_DETECTED_DB` | 未发现 |
| GitHub 仓库环境 | Codex GitHub API 检查 | 环境、部署、Secret/Variable 名称和协作者清点 | 2026-07-31 | `CONFIRMED_NO_REPOSITORY_DEPLOYMENT` | 未发现 |
| CI 历史数据库 | GitHub Actions | 运行 `30619545281`、Artifact `8788819226`、容器停止结果和 ZIP 清单 | 2026-07-31 | `EPHEMERAL_CI_ONLY` | 无数据库保留义务；证据保留 30 天 |
| 共享开发环境 | **待负责人确认** | 仓库无关联环境，需声明是否有仓库外服务器 | 2026-07-31 | `NO_LINKED_ENVIRONMENT` | `OWNER_ATTESTATION_REQUIRED` |
| 测试/预发布环境 | **待负责人确认** | GitHub 无环境/部署，Terraform 规定 M6 才创建资源 | 2026-07-31 | `NOT_PROVISIONED_BY_PROJECT` | `OWNER_ATTESTATION_REQUIRED` |
| 腾讯云及其他云账号 | **待负责人确认** | 仓库和本机无项目关联配置，需核对账号控制台 | 2026-07-31 | `NO_PROJECT_LINKED_CLOUD_RESOURCE` | `OWNER_ATTESTATION_REQUIRED` |
| 其他电脑、备份、快照与灾备 | **待负责人确认** | 当前证据无法覆盖其他设备、账号或离线介质 | 2026-07-31 | `OUTSIDE_TECHNICAL_VISIBILITY` | `OWNER_ATTESTATION_REQUIRED` |

## 待批准决定

此前迁移只在所有外部环境均确认无保留义务并获批准后才能作为未发布验证产物退役。当前最终态候选为
`20260715000000_m1_final_state_candidate`。任何旧 M1 数据库都不能直接应用该候选。

当前迁移字节只由 `migration-candidate.sha256` 记录候选指纹，不代表冻结或批准。批准与原生验收完成后：

1. 生成新的最终发布摘要，随后迁移 SQL 不得原地编辑；
2. 所有结构变化只能创建新迁移并追加摘要；
3. CI 必须从空 PostgreSQL 16 执行 `prisma migrate deploy`；
4. 发布前必须执行 `prisma migrate status`，发现已应用迁移摘要不同立即停止；
5. 如果发现未披露的持久旧库，重置方案立即失效，必须另行设计前向收敛。

## 批准声明

只有项目/发布负责人可以确认以下声明：

> 我已核对上表全部环境，确认不存在需要保留的旧 M1 数据库或数据；批准删除所有旧 M1 临时库并从空库部署最终基线。我理解一旦发现遗漏数据库，必须立即停止部署并转为前向迁移方案。

批准人签署：**待填写**

## 当前证据边界

GitHub Actions 已在原生 PostgreSQL 16.8 与 Redis 7.4.2 中通过空库首次部署、二次幂等部署、
迁移状态、对象清单、并发、队列及依赖审计。Artifact ZIP 的 SHA-256 为
`7836b9f662b81ed669fdbf1e9d1cb3dbd5a6bf8f7e401cb7fb0bdc6598b10933`。

但当前私人仓库套餐不支持 branch protection 或 rulesets，相关 GitHub API 返回 HTTP 403；负责人
范围外声明和重置批准也尚未完成。因此不得冻结迁移、不得重置数据库，M1 继续保持 `BLOCKED`。
