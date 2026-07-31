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
  'docs/verification/m3-entry-approval.md',
  'docs/verification/m3-invariants.md',
  'docs/verification/milestone-m3.md',
  'docs/verification/m3-baseline.sha256',
  'docs/architecture/m3-grouping-design.md',
  'apps/api/src/catalog/catalog.controller.ts',
  'apps/api/src/catalog/catalog.service.ts',
  'apps/api/src/catalog/route-windows.ts',
  'apps/api/src/grouping/grouping.controller.ts',
  'apps/api/src/grouping/grouping.service.ts',
  'apps/api/test/native-m3.e2e.test.ts',
  'apps/worker/src/formation-timeout.ts',
  'apps/worker/test/native-m3-timeout.e2e.test.ts',
  'packages/domain/src/index.ts',
  'packages/domain/test/index.test.ts',
  'apps/miniprogram/miniprogram/pages/group/index.ts',
  'apps/miniprogram/miniprogram/pages/formation/index.ts',
  '.github/workflows/m3-quality.yml'
)
foreach ($relative in $requiredFiles) {
  Assert-True (Test-Path -LiteralPath (Join-Path $root $relative) -PathType Leaf) "required M3 file exists: $relative"
}

$entry = Read-Utf8 'docs/verification/m3-entry-approval.md'
Assert-True ($entry -match '(?m)^- User instruction: .+M3`$') 'M3 entry records explicit user approval'
Assert-True ($entry -match '9e8ef667a43c526a21d2505eff22adb0c83cf978') 'M3 starts from the accepted M2 main commit'
Assert-True ($entry -match 'Cedric') 'M3 entry records the accountable approver'

$invariants = Read-Utf8 'docs/verification/m3-invariants.md'
foreach ($invariant in @('INV-001', 'INV-002', 'INV-003', 'INV-004', 'INV-005', 'INV-006')) {
  Assert-True ($invariants -match [regex]::Escape($invariant)) "M3 invariant is documented: $invariant"
}
Assert-True ($invariants -match 'one to three seats') 'M3 documents the per-account seat boundary'
Assert-True ($invariants -match 'two distinct active') 'M3 documents the independent-account readiness boundary'
Assert-True ($invariants -match 'never\s+creates service orders') 'M3 documents the M4 financial boundary'

$domain = Read-Utf8 'packages/domain/src/index.ts'
foreach ($guard in @(
  'occupiedSeats > 4',
  'member.seatCount < 1',
  'member.seatCount > 3',
  'userIds.has(member.userId)',
  'userIds.size === 1 ? "RECRUITING" : "READY"',
  'SAME_GENDER_ONLY',
  'Formation requires at least two distinct accounts'
)) {
  Assert-True ($domain -match [regex]::Escape($guard)) "domain grouping guard exists: $guard"
}
$domainCoverage = Read-Utf8 'packages/domain/vitest.config.ts'
foreach ($metric in @('statements', 'branches', 'functions', 'lines')) {
  Assert-True ($domainCoverage -match "$metric\s*:\s*90") "domain $metric coverage threshold remains at least 90 percent"
}

$grouping = Read-Utf8 'apps/api/src/grouping/grouping.service.ts'
foreach ($guard in @(
  'requireEligibleUser',
  'requireEnabledRouteWindow',
  'rejectOverlappingDemand',
  'groupingSnapshotHash',
  'CONTACT_CONSENT_VERSION_MISMATCH',
  'serializableAttempts: 5',
  'state: RoundState.PAYING',
  'status: MemberStatus.PAYMENT_PENDING'
)) {
  Assert-True ($grouping -match [regex]::Escape($guard)) "grouping guard exists: $guard"
}
Assert-True ($grouping -match 'GROUP_PAGE_SIZE = 20') 'candidate-group pagination has a bounded page size'
Assert-True ($grouping -match 'GROUP_SCAN_BATCH_LIMIT = 5') 'candidate-group filtering has a bounded scan limit'
Assert-True (-not ($grouping -match '\.(serviceOrder|paymentTransaction|refund|contactUnlock)\.(create|update|upsert|delete)')) 'M3 grouping creates no financial or contact-unlock records'

$idempotency = Read-Utf8 'apps/api/src/m2/idempotency.service.ts'
Assert-True ($idempotency -match 'SERIALIZABLE_TRANSACTION_ATTEMPTS = 3') 'historical default transaction retry count remains three'
Assert-True ($idempotency -match 'serializableAttempts > 8') 'extended retry configuration remains strictly bounded'
Assert-True ($idempotency -match 'boundedSerializationBackoff') 'serializable retry uses bounded backoff'

$controller = Read-Utf8 'apps/api/src/grouping/grouping.controller.ts'
foreach ($route in @('Controller("demands")', 'Controller("groups")', 'Controller("formation-rounds")', 'HttpCode(200)')) {
  Assert-True ($controller -match [regex]::Escape($route)) "M3 controller surface exists: $route"
}

$nativeApi = Read-Utf8 'apps/api/test/native-m3.e2e.test.ts'
Assert-True (([regex]::Matches($nativeApi, 'attempt < 20')).Count -ge 3) 'native M3 API repeats seat, overlap and confirmation races for 20 rounds'
foreach ($evidence in @(
  'without overselling',
  'overlapping-group membership races',
  'concurrent confirmation',
  'invalidates a declined round',
  'rawPayload.toString("utf8")',
  'not.toMatch(/wechat|contact|userId|gender/i)',
  'serviceOrder.count',
  'paymentTransaction.count',
  'contactUnlock.count'
)) {
  Assert-True ($nativeApi -match [regex]::Escape($evidence)) "native M3 API evidence exists: $evidence"
}

$worker = Read-Utf8 'apps/worker/src/formation-timeout.ts'
Assert-True ($worker -match 'state: RoundState.CONFIRMING') 'timeout worker selects only confirming rounds'
Assert-True ($worker -match 'round\.group\.state !== GroupState\.CONFIRMING') 'timeout worker rechecks the group state'
Assert-True ($worker -match 'state: \{ in: \[GroupState\.RECRUITING, GroupState\.READY\] \}') 'expiry worker selects only recruitable groups'
Assert-True (-not ($worker -match 'GroupState\.PAYING.*data:')) 'timeout worker never mutates PAYING groups'
Assert-True (-not ($worker -match '\.(serviceOrder|paymentTransaction|refund|contactUnlock)\.(create|update|upsert|delete)')) 'M3 worker creates no financial or contact-unlock records'
$nativeWorker = Read-Utf8 'apps/worker/test/native-m3-timeout.e2e.test.ts'
Assert-True ($nativeWorker -match 'state: GroupState\.PAYING') 'native worker test preserves PAYING state'
Assert-True ($nativeWorker -match 'resolves\.toBe\(false\)') 'native worker test proves replay is a no-op'

$openApi = Read-Utf8 'docs/api/openapi.yaml'
foreach ($operation in @(
  'listCampusRoutes',
  'createDemand',
  'listMyDemands',
  'cancelDemand',
  'listGroups',
  'getGroup',
  'joinGroup',
  'leaveGroup',
  'startFormationRound',
  'getFormationRound',
  'confirmFormationRound',
  'createRoute'
)) {
  Assert-True ($openApi -match "operationId:\s*$operation") "OpenAPI M3 operation exists: $operation"
}

$miniApp = Read-Utf8 'apps/miniprogram/miniprogram/app.json'
Assert-True ($miniApp -match 'pages/group/index') 'mini-program registers the group detail page'
Assert-True ($miniApp -match 'pages/formation/index') 'mini-program registers the formation page'
$miniSources = @(
  (Read-Utf8 'apps/miniprogram/miniprogram/pages/home/index.ts'),
  (Read-Utf8 'apps/miniprogram/miniprogram/pages/publish/index.ts'),
  (Read-Utf8 'apps/miniprogram/miniprogram/pages/trips/index.ts'),
  (Read-Utf8 'apps/miniprogram/miniprogram/pages/group/index.ts'),
  (Read-Utf8 'apps/miniprogram/miniprogram/pages/formation/index.ts')
) -join "`n"
Assert-True (-not ($miniSources -match 'requestPayment|service-orders|/contacts')) 'M3 mini-program contains no payment or contact-unlock call'

$apiCoverage = Read-Utf8 'apps/api/vitest.config.ts'
foreach ($metric in @('statements', 'branches', 'functions', 'lines')) {
  Assert-True ($apiCoverage -match "$metric\s*:\s*80") "API $metric coverage threshold remains 80 percent"
}

$workflow = Read-Utf8 '.github/workflows/m3-quality.yml'
foreach ($guard in @(
  'name: m3-quality-gates',
  'native-m3.e2e.test.ts',
  'native-m3-timeout.e2e.test.ts',
  'M3-API 5',
  'M3-WORKER 1',
  '.m3-evidence/sha256sums.txt',
  'm3-verification-'
)) {
  Assert-True ($workflow -match [regex]::Escape($guard)) "M3 CI evidence guard exists: $guard"
}

$rootPackage = Read-Utf8 'package.json' | ConvertFrom-Json
Assert-True ($rootPackage.scripts.check -match 'verify:m2 && pnpm verify:m3') 'full quality gate preserves M2 and adds M3 verification'

$m1Migration = Join-Path $root 'packages/database/prisma/migrations/20260715000000_m1_final_state_candidate/migration.sql'
$m2Migration = Join-Path $root 'packages/database/prisma/migrations/20260731000000_m2_sensitive_info_policy/migration.sql'
Assert-True ((Get-FileHash -Algorithm SHA256 -LiteralPath $m1Migration).Hash.ToLowerInvariant() -eq '6d893aa089650d72b717546960679aad1f3f61abe8b32ba07ed2a623ad605902') 'released M1 migration remains immutable'
Assert-True ((Get-FileHash -Algorithm SHA256 -LiteralPath $m2Migration).Hash.ToLowerInvariant() -eq 'fb8e9e49d97db759d8eb441ff2f89e6dd54c13e3a4bb35eab350c4f807e5a681') 'released M2 migration remains immutable'
$migrationDirectories = Get-ChildItem -LiteralPath (Split-Path $m1Migration -Parent | Split-Path -Parent) -Directory
Assert-True ($migrationDirectories.Count -eq 2) 'M3 requires no database migration beyond the accepted M1 and M2 chain'

$baselinePath = Join-Path $root 'docs/verification/m3-baseline.sha256'
if (Test-Path -LiteralPath $baselinePath -PathType Leaf) {
  $manifestDigest = (Get-FileHash -Algorithm SHA256 -LiteralPath $baselinePath).Hash.ToLowerInvariant()
  Assert-True ($manifestDigest -eq 'd5cac0231aef26f0ceea2cb5a5eec3389cfed6abc891ba7a72005cb06d377fa7') 'M3 baseline manifest itself remains byte-for-byte immutable'
  $baselineLines = Get-Content -LiteralPath $baselinePath -Encoding utf8 | Where-Object { $_ -match '^[a-f0-9]{64} \*' }
  Assert-True ($baselineLines.Count -ge 20) 'M3 baseline covers implementation, tests, workflow and verification evidence'
}

if (-not $Quiet) {
  Write-Host ""
  Write-Host "M3 checks: $($passes.Count) passed, $($failures.Count) failed"
}
if ($failures.Count -gt 0) { throw "M3 verification failed: $($failures -join '; ')" }
