# M0 需求追踪矩阵

| 需求 | 架构/决策 | 领域约束 | API/页面 | 威胁 |
|---|---|---|---|---|
| 2—4座且至少2账号 | ADR-003 | INV-001、INV-002 | createDemand、joinGroup、组详情 | T-004 |
| 每账号1—3座 | ADR-003 | GroupMember.seatCount | CreateDemandRequest | T-004 |
| 每账号99分 | ADR-003、ADR-009 | INV-007 | createServiceOrder；amountFen const 99 | T-002、T-003 |
| 全员付款后解锁 | ADR-005、ADR-011 | INV-008、INV-009 | confirmFormationRound、getUnlockedContacts | T-001、T-002 |
| 联系方式同意版本、整组披露与撤回 | ADR-011、ADR-012 | ContactConsent/ContactAccessLog、INV-008、INV-009 | revokeContactConsent、getUnlockedContacts | T-001、T-005、T-008 |
| 超时移除并全轮退款 | ADR-004、ADR-011 | Group/FormationRound/Order 补偿状态机 | refund API/回调 | T-003、T-005、T-011 |
| 固定路线 | ADR-006 | Route/RouteSchedule | listCampusRoutes、发布页 | T-015 |
| 人工学生认证 | ADR-007、ADR-011、ADR-012、ADR-014 | AWAITING/UPLOAD_EXPIRED/RESUBMISSION/VERIFICATION_EXPIRED 状态机、有限期 CHECK、边界同步授权、INV-004、INV-011 | verifications、createResubmissionUpload、认证审核页 | T-006、T-007、到期边界/重放/乱序测试 |
| 同性偏好 | ADR-008 | INV-005 | CreateDemandRequest | T-012 |
| 只撮合、不运输 | ADR-005、ADR-006 | INV-014 | 页面边界和OpenAPI描述 | T-017 |
| 管理员TOTP/RBAC与单次材料访问 | ADR-011、ADR-012、架构总览第5节 | AdminSession/VerificationAssetAccessGrant、原子消费函数、INV-011—INV-013 | adminLogin、issueVerificationAssetAccess、consumeVerificationAssetGrant、后台权限页 | T-007、T-009、T-010、T-014 |
| 分类幂等和审计 | ADR-002、ADR-010、ADR-011 | INV-010、INV-013 | 业务 Idempotency-Key、认证令牌族、回调事务号、AuditLog | T-003、T-013 |

追踪矩阵在每个里程碑追加“测试证据”列。实现若无法映射到需求、约束或威胁，默认视为未授权范围扩张。
