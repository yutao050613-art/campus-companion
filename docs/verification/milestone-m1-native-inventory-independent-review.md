# M1 原生对象清点整改独立复核记录

日期：2026-07-15（Asia/Shanghai）
状态：**R-01 实现缺口关闭，R-02 关闭；M1 继续 BLOCKED**

## 复核输入与原始字节摘要

本轮收到的独立复核文件：`m1-native-inventory-remediation-review.md`

`SHA-256(raw-bytes): 03ba047de669ad38bd8fdf230ad4e9ecc0c1c5be75434e656fcf13d0d9c3d156`

被该复核固定的整改报告保持原样：`milestone-m1-native-inventory-remediation.md`

`SHA-256(raw-bytes): cef2901961d095107f0052b727d853bebc49414436db0477aabfc80af6c9e68d`

当前工作区保留的上一轮附件 `f44f3ab6-4e24-41ad-bad0-4b40dc5cf5f5/pasted-text.txt` 原始字节摘要为：

`SHA-256(raw-bytes): fae941dcdcb6a4b53a6e7773c002ff9de53ee36edddbbf5d6afd452f736a4aeb`

独立复核提到另一个 LF 换行交付副本可能产生不同的原始摘要；该副本未作为本轮可访问文件提供，因此本记录不把其摘要冒充为已复算结果。内容规范化比较与原始文件字节摘要今后必须分开标记。

## 复核结论留档

- R-01：共享清单、PGlite/原生共同消费、CI 路由和结构门禁均成立；代码实现缺口关闭。
- R-02：一次性隔离验证与共享/持久/发布部署边界清晰，关闭。
- 未发现新的 P0/P1。
- 对象清点证明受监控对象名称集合与枚举顺序，不宣称函数体、约束定义或触发事件的逐字等价。
- PostgreSQL 16.8、Redis 7.4.2、在线审计、受保护 CI 和 DB-02 负责人签署仍未完成。

## 审计改进

验证标准已增加 `SHA-256(raw-bytes)` 与 `SHA-256(normalized-text)` 的强制区分。既有、已被独立复核固定的整改报告不原地改写，本记录作为追加澄清保留审计链。

本地结构复验：`verify:m0` 340/340，`verify:m1` 275/275；本记录落盘后的完整 `pnpm check` 为 PASS。全工作区 37 项测试通过，5 项原生 PostgreSQL/Redis 测试因本机缺少对应环境而明确跳过。

M1 状态保持 `BLOCKED`，不得冻结迁移或开始 M2。
