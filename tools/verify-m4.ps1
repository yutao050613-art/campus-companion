param([switch]$Quiet)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$failures = [System.Collections.Generic.List[string]]::new()
$passes = [System.Collections.Generic.List[string]]::new()

function Pass([string]$Message) {
  $passes.Add($Message)
  if (-not $Quiet) { Write-Host "PASS  $Message" -ForegroundColor Green }
}

function Fail([string]$Message) {
  $failures.Add($Message)
  if (-not $Quiet) { Write-Host "FAIL  $Message" -ForegroundColor Red }
}

function Assert-True([bool]$Condition, [string]$Message) {
  if ($Condition) { Pass $Message } else { Fail $Message }
}

function Read-Utf8([string]$RelativePath) {
  return Get-Content -LiteralPath (Join-Path $root $RelativePath) -Raw -Encoding utf8
}

$requiredFiles = @(
  'docs/verification/m4-entry-approval.md',
  'docs/verification/m4-invariants.md',
  'docs/verification/milestone-m4.md',
  'docs/verification/m4-baseline.sha256',
  'docs/architecture/m4-payment-design.md',
  'packages/payments/src/index.ts',
  'packages/database/prisma/migrations/20260801000000_m4_payment_delivery_guards/migration.sql',
  'apps/api/src/payments/payments.controller.ts',
  'apps/api/src/payments/payments.service.ts',
  'apps/api/test/m4-controllers.test.ts',
  'apps/api/test/native-m4.e2e.test.ts',
  'apps/worker/src/payment-refund.ts',
  'apps/worker/test/native-m4-payment-refund.e2e.test.ts',
  'apps/worker/vitest.config.ts',
  'apps/miniprogram/miniprogram/pages/payment/index.ts',
  'apps/miniprogram/miniprogram/pages/contacts/index.ts',
  'tools/pnpm-child.test.mjs',
  'tools/run-non-native-tests.mjs',
  '.github/workflows/m4-quality.yml'
)
foreach ($relative in $requiredFiles) {
  Assert-True (Test-Path -LiteralPath (Join-Path $root $relative) -PathType Leaf) "required M4 file exists: $relative"
}

$entry = Read-Utf8 'docs/verification/m4-entry-approval.md'
Assert-True ($entry -match 'Accepted M3 main commit: `c9c773dba37e99efe48d31a7af714562cd5de742`') 'M4 starts from the accepted M3 main commit'
Assert-True ($entry -match 'Cedric') 'M4 entry records the accountable approver'
Assert-True ($entry -match 'mock-only') 'M4 entry limits payment to the mock gateway'

$invariants = Read-Utf8 'docs/verification/m4-invariants.md'
foreach ($invariant in @('INV-007', 'INV-008', 'INV-009', 'INV-010', 'INV-015', 'INV-016')) {
  Assert-True ($invariants -match [regex]::Escape($invariant)) "M4 invariant is documented: $invariant"
}
Assert-True ($invariants -match '99 fen') 'M4 documents server-owned 99-fen pricing'
Assert-True ($invariants -match 'all-or-nothing') 'M4 documents all-or-nothing contact reads'
Assert-True ($invariants -match 'development' -and $invariants -match 'test') 'M4 documents the mock-environment boundary'

$migration = Read-Utf8 'packages/database/prisma/migrations/20260801000000_m4_payment_delivery_guards/migration.sql'
foreach ($guard in @(
  'Refund_orderId_reason_key',
  'DROP CONSTRAINT "PaymentTransaction_occurred_check"',
  'enforce_m4_service_order_guard',
  'ServiceOrder_m4_paying_guard',
  'enforce_m4_contact_unlock_guard',
  'ContactUnlock_m4_delivery_guard',
  'NEW."amountFen" <> 99',
  'NEW."viewerId" <> NEW."subjectId"'
)) {
  Assert-True ($migration -match [regex]::Escape($guard)) "M4 database guard exists: $guard"
}

$payments = Read-Utf8 'packages/payments/src/index.ts'
foreach ($guard in @('amountFen: 99', 'assertEnabled', 'development', 'test', 'mock_intent_', 'mock_txn_', 'mock_ref_')) {
  Assert-True ($payments -match [regex]::Escape($guard)) "mock gateway guard exists: $guard"
}
Assert-True ($payments -notmatch 'wechatpay|api-v3|private.?key') 'M4 payment package contains no real-payment implementation'

$config = Read-Utf8 'apps/api/src/config.ts'
Assert-True ($config -match 'mock payment is forbidden outside development and test') 'API fails closed for mock payment outside local environments'
Assert-True ($config -match 'WeChat Pay is not configured until M5') 'API fails closed for premature real payment configuration'
$workerConfig = Read-Utf8 'apps/worker/src/config.ts'
Assert-True ($workerConfig -match 'mock payment is forbidden outside development and test') 'worker fails closed for mock payment outside local environments'

$service = Read-Utf8 'apps/api/src/payments/payments.service.ts'
foreach ($guard in @(
  'const PRICE_FEN = 99',
  'requirePayingMember',
  'formationSnapshotHash',
  'deliverIfComplete',
  'beginCompensation',
  'CONTACTS_NOT_UNLOCKED',
  'contactAccessLog.create',
  'serializableAttempts: 5',
  'CONTACT_UNLOCKED',
  'RefundReason.ROUND_INVALIDATED'
)) {
  Assert-True ($service -match [regex]::Escape($guard)) "payment delivery guard exists: $guard"
}
Assert-True ($service -notmatch 'amountFen:\s*(?:input|body|request)') 'payment amount is not client-owned'
Assert-True ($service -notmatch 'console\.(?:log|error|warn)') 'payment service has no unsafe console logging'

$controller = Read-Utf8 'apps/api/src/payments/payments.controller.ts'
foreach ($route in @('me/contact', 'service-orders', 'mock-settlement', 'contact-consent', 'groups/:groupId/contacts')) {
  Assert-True ($controller -match [regex]::Escape($route)) "M4 controller route exists: $route"
}
Assert-True ($controller -match 'MockSettlementSchema') 'mock settlement DTO is constrained'
Assert-True ($controller -notmatch 'amountFen') 'controller accepts no client price'

$nativeApi = Read-Utf8 'apps/api/test/native-m4.e2e.test.ts'
Assert-True (([regex]::Matches($nativeApi, 'attempt < 20')).Count -ge 2) 'native M4 API repeats delivery and consent races 20 times'
foreach ($evidence in @('forged payment facts', 'all-or-nothing contact delivery', 'future contact read', 'rawPayload.toString', 'paymentTransaction.count')) {
  Assert-True ($nativeApi -match [regex]::Escape($evidence)) "native M4 API evidence exists: $evidence"
}
$nativeWorker = Read-Utf8 'apps/worker/test/native-m4-payment-refund.e2e.test.ts'
Assert-True ($nativeWorker -match 'attempt < 20') 'native M4 worker repeats timeout/refund recovery 20 times'
Assert-True ($nativeWorker -match 'REFUND_RETRY') 'native M4 worker tests retry/manual-review state'

$worker = Read-Utf8 'apps/worker/src/payment-refund.ts'
foreach ($guard in @('PAYMENT_TIMEOUT', 'REFUND_PENDING', 'REFUND_RETRY', 'MockRefundRetryScheduled', 'runSerializableWithRetry')) {
  Assert-True ($worker -match [regex]::Escape($guard)) "payment refund worker guard exists: $guard"
}
$workerTestConfig = Read-Utf8 'apps/worker/vitest.config.ts'
Assert-True ($workerTestConfig -match 'fileParallelism: process\.env\["NATIVE_POSTGRES_TESTS"\] !== "true"') 'native worker database test files run serially'

$miniApp = Read-Utf8 'apps/miniprogram/miniprogram/app.json'
Assert-True ($miniApp -match 'pages/payment/index') 'mini-program registers the payment page'
Assert-True ($miniApp -match 'pages/contacts/index') 'mini-program registers the contact disclosure page'
$miniSources = @(
  (Read-Utf8 'apps/miniprogram/miniprogram/pages/payment/index.ts'),
  (Read-Utf8 'apps/miniprogram/miniprogram/pages/contacts/index.ts')
) -join "`n"
Assert-True ($miniSources -match 'mock-settlement') 'mini-program uses the M4 mock settlement endpoint'
Assert-True ($miniSources -match '/contacts') 'mini-program uses the gated contact endpoint'
Assert-True ($miniSources -notmatch 'requestLocation|chooseLocation|driver|vehicle|fare') 'M4 mini-program contains no transport or location scope'

$openApi = Read-Utf8 'docs/api/openapi.yaml'
foreach ($operation in @('updateMyContact', 'createServiceOrder', 'getServiceOrder', 'createPrepay', 'settleMockServiceOrder', 'getUnlockedContacts')) {
  Assert-True ($openApi -match "operationId:\s*$operation") "OpenAPI M4 operation exists: $operation"
}

$apiCoverage = Read-Utf8 'apps/api/vitest.config.ts'
foreach ($metric in @('statements', 'branches', 'functions', 'lines')) {
  Assert-True ($apiCoverage -match "$metric\s*:\s*80") "API $metric coverage threshold remains 80 percent"
}

$workflow = Read-Utf8 '.github/workflows/m4-quality.yml'
foreach ($guard in @('name: m4-quality-gates', 'native-m4.e2e.test.ts', 'native-m4-payment-refund.e2e.test.ts', 'M4-API 4', 'M4-WORKER 1', '.m4-evidence/sha256sums.txt', 'm4-verification-')) {
  Assert-True ($workflow -match [regex]::Escape($guard)) "M4 CI evidence guard exists: $guard"
}

$rootPackage = Read-Utf8 'package.json' | ConvertFrom-Json
Assert-True ($rootPackage.scripts.check -match 'verify:m3 && pnpm verify:m4') 'full quality gate preserves M3 and adds M4 verification'
Assert-True ($rootPackage.scripts.test -match 'pnpm test:tools' -and $rootPackage.scripts.'test:coverage' -match 'pnpm test:tools') 'test gates include the portable pnpm runner test'
$pnpmChild = Read-Utf8 'tools/pnpm-child.mjs'
Assert-True ($pnpmChild -match 'platform === "win32"' -and $pnpmChild -match 'command: "pnpm"') 'pnpm runner selects a safe Windows or POSIX executable'
$pnpmChildTest = Read-Utf8 'tools/pnpm-child.test.mjs'
Assert-True ($pnpmChildTest -match '"win32"' -and $pnpmChildTest -match '"linux"' -and $pnpmChildTest -match 'shell: false') 'pnpm runner has Windows and POSIX regression coverage'
Assert-True ($rootPackage.scripts.'test:coverage' -match 'run-non-native-tests') 'coverage gate isolates native database suites'
$nonNativeRunner = Read-Utf8 'tools/run-non-native-tests.mjs'
Assert-True ($nonNativeRunner -match 'NATIVE_POSTGRES_TESTS: "false"') 'non-native runner disables parallel PostgreSQL suites'
Assert-True ($nonNativeRunner -match 'NATIVE_REDIS_TESTS: "false"') 'non-native runner disables parallel Redis suites'

$m1Migration = Join-Path $root 'packages/database/prisma/migrations/20260715000000_m1_final_state_candidate/migration.sql'
$m2Migration = Join-Path $root 'packages/database/prisma/migrations/20260731000000_m2_sensitive_info_policy/migration.sql'
Assert-True ((Get-FileHash -Algorithm SHA256 -LiteralPath $m1Migration).Hash.ToLowerInvariant() -eq '6d893aa089650d72b717546960679aad1f3f61abe8b32ba07ed2a623ad605902') 'released M1 migration remains immutable'
Assert-True ((Get-FileHash -Algorithm SHA256 -LiteralPath $m2Migration).Hash.ToLowerInvariant() -eq 'fb8e9e49d97db759d8eb441ff2f89e6dd54c13e3a4bb35eab350c4f807e5a681') 'released M2 migration remains immutable'

$baselinePath = Join-Path $root 'docs/verification/m4-baseline.sha256'
if (Test-Path -LiteralPath $baselinePath -PathType Leaf) {
  $baselineLines = Get-Content -LiteralPath $baselinePath -Encoding utf8 | Where-Object { $_ -match '^[a-f0-9]{64} \*' }
  Assert-True ($baselineLines.Count -ge 40) 'M4 baseline covers the full implementation, tests, workflow and report'
  foreach ($requiredEntry in @(
    '*packages/database/prisma/migrations/20260801000000_m4_payment_delivery_guards/migration.sql',
    '*packages/payments/src/index.ts',
    '*packages/payments/test/index.test.ts',
    '*apps/api/src/payments/payments.service.ts',
    '*apps/worker/src/payment-refund.ts',
    '*tools/pnpm-child.mjs',
    '*tools/run-native-api-quality.mjs',
    '*tools/verify-m4.ps1',
    '*docs/verification/milestone-m4.md'
  )) {
    Assert-True (($baselineLines | Where-Object { $_ -like $requiredEntry }).Count -eq 1) "M4 baseline retains $requiredEntry"
  }
  foreach ($line in $baselineLines) {
    $parts = $line -split ' \*', 2
    if ($parts.Count -ne 2) {
      Fail "M4 baseline entry is malformed: $line"
      continue
    }
    $relativePath = $parts[1]
    $path = Join-Path $root $relativePath
    Assert-True (Test-Path -LiteralPath $path -PathType Leaf) "M4 baseline target exists: $relativePath"
    if (Test-Path -LiteralPath $path -PathType Leaf) {
      $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
      Assert-True ($actual -eq $parts[0]) "M4 baseline target hash matches: $relativePath"
    }
  }
}

if (-not $Quiet) {
  Write-Host ""
  Write-Host "M4 checks: $($passes.Count) passed, $($failures.Count) failed"
}
if ($failures.Count -gt 0) { throw "M4 verification failed: $($failures -join '; ')" }
