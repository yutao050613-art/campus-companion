# 校园同行（Campus Companion）

面向高校学生的同路线乘客信息撮合系统。平台负责学生认证、结构化同行需求、2—4 座组队、信息服务费和联系方式授权解锁；不提供司机、车辆、叫车、运价、车费结算或运输服务。

## 已锁定的业务规则

- 一个组总座位数为 2—4，且至少有 2 个独立、有效的认证学生账号。
- 单账号可填写 1—3 个座位；信息服务费按账号收取，每个账号 0.99 元（99 分）。
- 发布、浏览和加入免费；达到成团条件后可继续等待，也可发起 5 分钟确认。
- 所有当前成员确认并付款、完成联系方式共享授权后，才公开组内微信号。
- 付款超时者被移除；该轮成团全部失效，已付款订单退款，剩余成员重新确认。
- 学生自行在合规第三方平台叫车并协商车费；系统不记录司机、车辆、实际车费或运输履约。

## 交付方式

项目按 M0—M7 里程碑开发。每个里程碑必须通过业务规则、自动测试、安全负向测试和人工复核，并生成 `docs/verification/` 验证报告后暂停。

当前状态：**M0 已获独立技术复核 PASS、等待用户重新确认；M1 仍 BLOCKED**。最新独立复核确认
M0 的无歧义认证状态、材料 Grant 原子单次消费和整组联系方式审计已关闭原阻断项，同时指出 M1
曾原地修改预发布迁移，以及认证有效期仍有空值歧义。F-02 已获独立关闭；F-01 当前改为 Prisma
from-empty 最终态迁移候选，不再包含历史枚举升级或数据回填，也不再提前宣称冻结。外部环境清点、
项目/发布负责人重置批准、原生 PostgreSQL 16、Redis 7 与联网依赖审计仍未完成，M2 未开始。
第二轮独立复核指出的原生数据库对象清点实现缺口已补齐，但仍必须在 PostgreSQL 16.8 的一次性隔离环境中实际执行后才能形成验收证据。

安装依赖后，在 Windows PowerShell 中执行 `pnpm check` 可重复运行本地完整门禁；
`pnpm verify:m0` 和 `pnpm verify:m1` 可分别运行结构验证。

## 目标仓库结构

```text
apps/
  miniprogram/     微信原生 TypeScript 小程序
  api/             NestJS + Fastify API
  worker/          BullMQ 异步任务
  admin/           React + Vite 运营后台
packages/
  domain/          无框架领域规则与状态机
  contracts/       DTO、错误码与生成类型
  database/        Prisma Schema 与迁移
  auth/            用户和管理员认证
  payments/        Mock/微信支付适配器
  observability/   日志、指标、链路与脱敏
  testing/         测试工厂和安全断言
infra/
  docker/          本地依赖服务
  terraform/       腾讯云广州基础设施
docs/
  architecture/    架构决策
  api/             OpenAPI 契约
  domain/          领域与状态机
  security/        威胁模型与合规边界
  verification/    里程碑验证证据
```

## 文档与验证入口

- [架构总览](docs/architecture/overview.md)
- [架构决策记录](docs/architecture/decisions.md)
- [领域模型与状态机](docs/domain/model.md)
- [OpenAPI 契约](docs/api/openapi.yaml)
- [威胁模型](docs/security/threat-model.md)
- [联系方式共享政策 v1](docs/policies/contact-sharing-v1.md)
- [验证标准](docs/verification/standard.md)
- [原 M0 历史报告（已被独立复核推翻）](docs/verification/milestone-m0.md)
- [M0 修复验证报告](docs/verification/milestone-m0-remediation.md)
- [第二轮 M0 修复验证报告](docs/verification/milestone-m0-remediation-followup.md)
- [M0 第二轮修复独立复核记录](docs/verification/milestone-m0-independent-review.md)
- [M0 文件摘要基线](docs/verification/m0-baseline.sha256)
- [M1 数据库重置决定](docs/verification/m1-database-reset-decision.md)
- [迁移候选指纹](docs/verification/migration-candidate.sha256)
- [M1 工程摘要基线](docs/verification/m1-baseline.sha256)
- [M1 迁移与有效期整改报告](docs/verification/milestone-m1-database-remediation.md)
- [M1 数据库整改第二轮报告](docs/verification/milestone-m1-database-remediation-followup.md)
- [M1 原生数据库对象清点整改报告](docs/verification/milestone-m1-native-inventory-remediation.md)
- [M1 原生对象清点整改独立复核记录](docs/verification/milestone-m1-native-inventory-independent-review.md)
- [M1 验证报告](docs/verification/milestone-m1.md)

## 安全提示

微信 AppSecret、商户私钥、APIv3 Key、联系方式加密密钥和管理员 TOTP 秘钥不得进入小程序、Git、日志或聊天。开发环境仅使用模拟值；生产秘密进入腾讯云 KMS/Secret Manager。
