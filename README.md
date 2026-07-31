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

当前状态：**M0/M1 已验收；M2 本地质量门禁通过，等待受保护 CI 与用户最终确认**。
M2 已实现模拟微信登录、学生人工认证、管理员密码加 TOTP、校区权限、受控材料查看和并发安全删除；
材料支持学生卡照片、企业微信身份截图或两者。确认 M2 前暂停，不开始 M3。

安装依赖后，在 Windows PowerShell 中执行 `pnpm check` 可重复运行本地完整门禁；
`pnpm verify:m0`、`pnpm verify:m1` 和 `pnpm verify:m2` 可分别运行里程碑结构验证。

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
- [M2 进入批准](docs/verification/m2-entry-approval.md)
- [M2 安全不变量](docs/verification/m2-invariants.md)
- [M2 敏感信息政策](docs/policies/sensitive-information-v1.md)
- [M2 验证报告](docs/verification/milestone-m2.md)
- [M2 摘要基线](docs/verification/m2-baseline.sha256)

## 安全提示

微信 AppSecret、商户私钥、APIv3 Key、联系方式加密密钥和管理员 TOTP 秘钥不得进入小程序、Git、日志或聊天。开发环境仅使用模拟值；生产秘密进入腾讯云 KMS/Secret Manager。
