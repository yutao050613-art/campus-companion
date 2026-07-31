# 腾讯云基础设施

M1 只固定 Terraform 和腾讯云 Provider 版本范围，不创建云资源。M6 才定义广州地域的网络、负载均衡、容器、TencentDB PostgreSQL、Redis、COS、KMS、WAF、日志和告警。

真实密钥不得写入 `.tfvars` 或状态文件。M6 使用独立 CI 身份、远程加密状态、状态锁和最小权限策略。

