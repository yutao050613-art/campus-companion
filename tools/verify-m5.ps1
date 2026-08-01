param(
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$passes = [System.Collections.Generic.List[string]]::new()
$failures = [System.Collections.Generic.List[string]]::new()

function Pass([string]$message) { [void]$passes.Add($message); if (-not $Quiet) { Write-Host "PASS  $message" } }
function Fail([string]$message) { [void]$failures.Add($message); if (-not $Quiet) { Write-Host "FAIL  $message" } }
function Assert-True([bool]$condition, [string]$message) { if ($condition) { Pass $message } else { Fail $message } }
function Read-Utf8([string]$relativePath) {
  return Get-Content -LiteralPath (Join-Path $root $relativePath) -Raw -Encoding utf8
}

$required = @(
  'docs/architecture/m5-wechat-risk-design.md',
  'docs/verification/m5-entry-approval.md',
  'docs/verification/m5-invariants.md',
  'docs/verification/m5-m4-supersession.md',
  'docs/verification/milestone-m5.md',
  'packages/database/prisma/migrations/20260802000000_m5_provider_event_reconciliation/migration.sql',
  'packages/payments/src/wechat-pay-v3.ts',
  'apps/api/src/payments/wechat-callback.service.ts',
  'apps/api/src/payments/wechat-callback.controller.ts',
  'apps/api/test/native-m5.e2e.test.ts',
  'apps/api/src/trust/trust.service.ts',
  'apps/api/src/admin/admin-trust.service.ts',
  'packages/database/src/refund-recovery.ts',
  '.github/workflows/m5-quality.yml'
)
foreach ($relativePath in $required) {
  Assert-True (Test-Path -LiteralPath (Join-Path $root $relativePath) -PathType Leaf) "required M5 file exists: $relativePath"
}

$m1Migration = Join-Path $root 'packages/database/prisma/migrations/20260715000000_m1_final_state_candidate/migration.sql'
$m2Migration = Join-Path $root 'packages/database/prisma/migrations/20260731000000_m2_sensitive_info_policy/migration.sql'
$m4Migration = Join-Path $root 'packages/database/prisma/migrations/20260801000000_m4_payment_delivery_guards/migration.sql'
Assert-True ((Get-FileHash -Algorithm SHA256 -LiteralPath $m1Migration).Hash.ToLowerInvariant() -eq '6d893aa089650d72b717546960679aad1f3f61abe8b32ba07ed2a623ad605902') 'released M1 migration remains immutable'
Assert-True ((Get-FileHash -Algorithm SHA256 -LiteralPath $m2Migration).Hash.ToLowerInvariant() -eq 'fb8e9e49d97db759d8eb441ff2f89e6dd54c13e3a4bb35eab350c4f807e5a681') 'released M2 migration remains immutable'
Assert-True ((Get-FileHash -Algorithm SHA256 -LiteralPath $m4Migration).Hash.ToLowerInvariant() -eq 'ef82d17ba8831f8be85de1e6d906d2f4c58a8560db6bf4d12c7a9dba6f6949ca') 'released M4 migration remains immutable'

$migration = Read-Utf8 'packages/database/prisma/migrations/20260802000000_m5_provider_event_reconciliation/migration.sql'
foreach ($guard in @(
  'CREATE TABLE "ProviderEvent"',
  'CREATE TABLE "ReconciliationException"',
  'ProviderEvent_provider_eventId_key',
  'enforce_m5_provider_event_guard',
  'enforce_m5_payment_transaction_guard',
  'enforce_m5_refund_guard',
  'enforce_m5_reconciliation_exception_guard',
  'AND order_row."amountFen" = NEW."amountFen"',
  'ProviderEvent_amount_check',
  'Report_reporterId_createdAt_idx'
)) {
  Assert-True ($migration -match [regex]::Escape($guard)) "M5 database guard exists: $guard"
}

$callbacks = Read-Utf8 'apps/api/src/payments/wechat-callback.service.ts'
Assert-True ($callbacks -match 'decodeStrictUtf8') 'callback rejects non-round-trip UTF-8'
Assert-True ($callbacks -match 'parseAndVerifyNotification') 'callback verifies the provider envelope'
Assert-True ($callbacks -match 'ingestVerifiedWechatPaymentEvent') 'payment callback records a verified provider event'
Assert-True ($callbacks -match 'ingestVerifiedWechatRefundEvent') 'refund callback records a verified provider event'
Assert-True ($callbacks -notmatch 'console.(log|debug|info|warn|error)') 'callback contains no unsafe console logging'

$callbackController = Read-Utf8 'apps/api/src/payments/wechat-callback.controller.ts'
Assert-True ($callbackController -match 'isSafeHeaderValue') 'callback rejects multi-value or newline-bearing header inputs'
Assert-True ($callbackController -match 'payments/wechat/notify') 'payment callback route exists'
Assert-True ($callbackController -match 'refunds/wechat/notify') 'refund callback route exists'

$paymentService = Read-Utf8 'apps/api/src/payments/payments.service.ts'
foreach ($guard in @(
  'const PRICE_FEN = 99',
  'recordProviderEventDigestConflict',
  'applyVerifiedWechatPaymentEvent',
  'applyVerifiedWechatRefundEvent',
  'recoverRefundedFormationRound',
  'REFUND_NOT_ELIGIBLE',
  'REFUND_FACT_OR_STATE_MISMATCH'
)) {
  Assert-True ($paymentService -match [regex]::Escape($guard)) "payment application guard exists: $guard"
}

$protocol = Read-Utf8 'packages/payments/src/wechat-pay-v3.ts'
foreach ($guard in @(
  'api.mch.weixin.qq.com',
  'rejectUnauthorized: true',
  'agent: false',
  'MAX_PROVIDER_RESPONSE_BYTES',
  'WechatPayHttpsTransport',
  'parseWechatPayTransactionNotice',
  'parseWechatPayRefundNotice'
)) {
  Assert-True ($protocol -match [regex]::Escape($guard)) "payment protocol guard exists: $guard"
}
Assert-True ($protocol -notmatch 'globalThis\.fetch|\bfetch\(') 'payment protocol has no ambient fetch transport'

$config = Read-Utf8 'apps/api/src/config.ts'
Assert-True ($config -match 'WECHAT_PAY_CALLBACKS_ENABLED.*default\("false"\)') 'payment callbacks are disabled by default'
Assert-True ($config -match 'WECHAT_PAY_VERIFIER_PUBLIC_KEYS_JSON') 'callback verifier key set is configured explicitly'
Assert-True ($config -match 'PAYMENT_PROVIDER !== "mock"') 'outbound payment remains fail-closed until explicit activation'

$trust = Read-Utf8 'apps/api/src/trust/trust.service.ts'
foreach ($guard in @('MAX_REPORTS_PER_HOUR = 5', 'REPORT_WINDOW_MS', 'cannot report yourself', 'cannot block yourself', 'UserBlocked', 'UserUnblocked')) {
  Assert-True ($trust -match [regex]::Escape($guard)) "trust guard exists: $guard"
}
Assert-True ($trust -notmatch 'payload:s*{[^}]*description') 'report narrative is not copied into trust outbox payloads'

$grouping = Read-Utf8 'apps/api/src/grouping/grouping.service.ts'
Assert-True ($grouping -match 'rejectBlockedPair') 'grouping checks block relations before joining or formation'
$adminTrust = Read-Utf8 'apps/api/src/admin/admin-trust.service.ts'
foreach ($guard in @('SAFETY_REVIEWER', 'requireCsrf: true', 'REPORT_DECISION', 'ADMIN_REPORT_RESTRICTION', 'GroupState.RISK_HOLD', 'GroupState.DISPUTED')) {
  Assert-True ($adminTrust -match [regex]::Escape($guard)) "admin trust guard exists: $guard"
}

$recovery = Read-Utf8 'packages/database/src/refund-recovery.ts'
foreach ($guard in @('OrderStatus.REFUND_PENDING', 'OrderStatus.PAID', 'GroupState.REFUNDING', 'RoundRefundedAndRecovered', 'occupiedSeats > 4')) {
  Assert-True ($recovery -match [regex]::Escape($guard)) "refund recovery guard exists: $guard"
}

$m5Tests = @(
  'apps/api/test/m5-wechat-payment-event.service.test.ts',
  'apps/api/test/wechat-callback.service.test.ts',
  'apps/api/test/native-m5.e2e.test.ts',
  'apps/api/test/refunds.controller.test.ts',
  'apps/api/test/trust.service.test.ts',
  'apps/api/test/admin-trust.service.test.ts',
  'packages/payments/test/wechat-pay-v3.test.ts',
  'packages/database/test/migration.e2e.test.ts'
)
foreach ($relativePath in $m5Tests) {
  Assert-True (Test-Path -LiteralPath (Join-Path $root $relativePath) -PathType Leaf) "M5 test exists: $relativePath"
}

$nativeM5 = Read-Utf8 'apps/api/test/native-m5.e2e.test.ts'
Assert-True ($nativeM5 -match 'attempt < 20') 'native M5 API repeats provider-event delivery races 20 times'
Assert-True ($nativeM5 -match 'reconciliationException\.count') 'native M5 API proves conflicting replay is queued for review'
$m5Workflow = Read-Utf8 '.github/workflows/m5-quality.yml'
foreach ($guard in @('name: m5-quality-gates', 'native-m5.e2e.test.ts', 'M5-API 1', '.m5-evidence/sha256sums.txt', 'm5-verification-')) {
  Assert-True ($m5Workflow -match [regex]::Escape($guard)) "M5 CI evidence guard exists: $guard"
}

if (-not $Quiet) { Write-Host ""; Write-Host "M5 checks: $($passes.Count) passed, $($failures.Count) failed" }
if ($failures.Count -gt 0) { throw "M5 verification failed: $($failures -join '; ')" }
