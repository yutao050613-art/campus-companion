# M1 GitHub CI 与数据库环境清点证据

日期：2026-07-31（Asia/Shanghai）

状态：**技术清点完成；`main` 分支保护已启用；Cedric 已完成负责人范围外声明**

## GitHub 仓库与分支保护

- 仓库：`yutao050613-art/campus-companion`，公开仓库，默认分支 `main`。
- 当前协作者只有 `yutao050613-art`，权限为 `admin`；Git 历史也只有该身份提交。
- 最新受验证提交：`5f79b046ed805ddb1e53640be4a68e241c55ec42`。
- 必需检查的实际名称为 `verify`，由 GitHub Actions 应用（App ID `15368`）产生。
- 私有仓库阶段调用 branch protection/rulesets API 返回 HTTP 403；项目负责人随后明确批准将仓库公开。
- 可见性转换完成后，`main` 的 branch protection API 已成功写入并回读：
  - 所有变更必须通过 PR；当前单维护者阶段批准数为 0；
  - 必须通过由 GitHub Actions App ID `15368` 产生的最新 `verify` 检查，`strict=true`；
  - 管理员同样受约束，旧审查在新提交后失效；
  - 要求解决会话和线性历史；
  - 禁止强推和删除 `main`。
- 标记：`BRANCH_PROTECTION_ACTIVE`。
- 破坏性操作标记：`FORCE_PUSH_AND_DELETION_DISABLED`。

## 绿色 CI 原生证据

| 项目 | 证据 |
|---|---|
| Workflow run | `30619545281`，`quality-gates`，结论 `success` |
| Run URL | `https://github.com/yutao050613-art/campus-companion/actions/runs/30619545281` |
| Runner | Linux X64，Node `22.22.0`，pnpm `11.7.0` |
| PostgreSQL | 原生 PostgreSQL `16.8`，首次部署、二次幂等部署、迁移状态及 4 个原生测试全部成功 |
| Redis | 原生 Redis `7.4.2`，1 个原生队列测试成功 |
| 依赖审计 | info/low/moderate/high/critical 均为 0 |
| Artifact ID | `8788819226` |
| Artifact 名称 | `m1-verification-30619545281-1-5f79b046ed805ddb1e53640be4a68e241c55ec42` |
| Artifact ZIP SHA-256 | `7836b9f662b81ed669fdbf1e9d1cb3dbd5a6bf8f7e401cb7fb0bdc6598b10933` |

Artifact 文件清单只有安装、迁移、状态、测试、审计日志和 SHA-256 清单，没有数据库 dump、
数据卷、快照或业务数据。工作流的 `Stop containers` 步骤成功，因此该运行使用的是随 Job
销毁的 PostgreSQL/Redis 服务容器，而不是持久环境。

## 环境清点

| 范围 | 2026-07-31 证据 | 结论 | 数据保留义务 |
|---|---|---|---|
| 当前仓库工作区 | 只有 `.env.example`；没有真实 `.env`、部署记录或数据库文件 | `CONFIRMED_NO_PERSISTENT_DB` | 未发现 |
| 当前 Windows 主机 | Docker CLI `29.6.1` 存在但 daemon 未运行；没有 Docker 服务/进程/数据 VHD、WSL 发行版、PostgreSQL/Redis 程序目录、服务或 5432/6379 监听 | `CONFIRMED_NO_DETECTED_DB` | 未发现 |
| GitHub 仓库环境 | Environments 0、Deployments 0、Actions Secrets 0、Actions Variables 0 | `CONFIRMED_NO_REPOSITORY_DEPLOYMENT` | 未发现 |
| GitHub Actions 历史数据库 | 工作流固定使用 PostgreSQL `16.8-alpine` 与 Redis `7.4.2-alpine` 服务容器；绿色证据无 dump/快照 | `EPHEMERAL_CI_ONLY` | 无数据库保留义务；验证 Artifact 保留 30 天 |
| 共享开发环境 | 仓库没有关联环境，且 Cedric 已完成范围外声明 | `NO_LINKED_ENVIRONMENT` | `OWNER_ATTESTATION_COMPLETE；NONE_DECLARED` |
| 测试/预发布环境 | GitHub 无环境或部署，Terraform 规定 M6 才创建资源，Cedric 已完成范围外声明 | `NOT_PROVISIONED_BY_PROJECT` | `OWNER_ATTESTATION_COMPLETE；NONE_DECLARED` |
| 腾讯云及其他云账号 | 仓库和本机无项目关联配置，Cedric 已完成云账号声明 | `NO_PROJECT_LINKED_CLOUD_RESOURCE` | `OWNER_ATTESTATION_COMPLETE；NONE_DECLARED` |
| 其他电脑、离线备份、快照与灾备 | 仓库与 CI 无数据库备份，Cedric 已完成其他设备与离线介质声明 | `NO_PERSISTENT_COPY_DECLARED` | `OWNER_ATTESTATION_COMPLETE；NONE_DECLARED` |

## 负责人确认

技术证据已经消除当前工作区、当前主机、GitHub 仓库和 GitHub Actions 历史数据库的不确定性。
项目/发布负责人 Cedric 于 2026-07-31 18:05:26 +08:00 确认以下范围不存在任何旧 M1
数据库、dump、卷、快照或需保留数据：

1. 未连接到本仓库的共享开发、测试或预发布服务器；
2. 腾讯云及其他云账号中的手工创建资源；
3. 负责人自己的其他电脑、移动硬盘、NAS 或离线备份；
4. 任何未登记协作者持有的副本。

声明原文：

> 我确认不存在仓库外共享数据库、测试/预发布数据库、云端手工数据库、其他电脑数据库、
> 离线备份或需要保留的旧 M1 数据。

标记：`OWNER_ATTESTATION_COMPLETE`。一旦发现任一持久旧库，批准立即失效，必须放弃从空库
重置方案并设计前向收敛迁移。
