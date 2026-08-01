# M5 对 M4 可扩展文件的受审计覆盖

状态：`CANDIDATE — M5 终验前不得视为发布批准`

M4 的原始 SHA-256 基线 `m4-baseline.sha256`、M4 迁移
`20260801000000_m4_payment_delivery_guards` 及其历史验收报告保持原字节不变。M4 的
校验脚本曾将可扩展的 schema、支付服务和测试也逐字节锁定；这会使任何追加的、已审查的
M5 迁移误报为历史篡改。

本清单是唯一允许 `verify-m4` 在检测到 M5 迁移后跳过“当前工作树摘要必须等于 M4 摘要”
的例外集合。它不允许修改 M4 迁移，也不降低 M0–M3 的历史摘要校验。

| M4 基线文件 | M5 覆盖理由 |
|---|---|
| `packages/database/prisma/schema.prisma` | 增加外部支付事件、对账异常和退款商户编号。 |
| `packages/database/test/database-object-inventory.ts` | 列出 M5 追加的 PostgreSQL 约束、函数与触发器。 |
| `packages/database/test/migration.e2e.test.ts` | 验证空库、M4 快照、回调重放和跨校区约束。 |
| `packages/payments/src/index.ts` | 仅导出无网络的 API v3 协议实现；不执行真实请求。 |
| `apps/api/src/config.ts` | 仅在显式启用并提供密钥句柄时构造回调验签器，默认关闭。 |
| `apps/api/test/config.test.ts` | 覆盖回调密钥完整性、来源规范化和显式本地对象存储的 M5 配置分支。 |
| `apps/api/src/app.module.ts` | 注册关闭默认值的回调控制器与服务。 |
| `apps/api/src/payments/payments.service.ts` | 追加两段式事件入库、幂等和对账隔离逻辑。 |
| `apps/worker/src/payment-refund.ts` | 改为复用同一事务性退款恢复状态机，防止模拟退款与经验证微信退款回调分叉。 |
| `docs/api/openapi.yaml` | 补充已实现的微信回调、退款、举报、拉黑和受 CSRF/TOTP 会话保护的安全审核接口。 |
| `package.json` | 将 M5 验证器纳入完整质量门禁，但不改变既有 M0—M4 门禁顺序。 |
| `tools/verify-m4.ps1` | 读取本受限清单，保留历史 M4 不可变迁移检查。 |

任何新增文件、扩大以上路径范围、修改本清单或删除历史 M4 基线，都必须由 M5 验证脚本
显式拒绝并在新的受保护 PR 中复核。
