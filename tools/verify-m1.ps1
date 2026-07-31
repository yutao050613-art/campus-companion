param(
  [switch]$Quiet
)

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
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  'biome.json',
  'redocly.yaml',
  'tools/security-static.ps1',
  'tools/assert-native-vitest-report.mjs',
  '.github/workflows/ci.yml',
  '.github/dependabot.yml',
  'apps/api/src/main.ts',
  'apps/api/src/common/api-exception.filter.ts',
  'apps/api/vitest.config.ts',
  'apps/worker/src/main.ts',
  'apps/admin/src/App.tsx',
  'apps/miniprogram/miniprogram/app.json',
  'packages/contracts/src/index.ts',
  'packages/domain/src/index.ts',
  'packages/observability/src/index.ts',
  'packages/database/prisma/schema.prisma',
  'packages/database/prisma/migrations/migration_lock.toml',
  'packages/database/prisma/migrations/20260715000000_m1_final_state_candidate/migration.sql',
  'packages/database/test/database-object-inventory.ts',
  'docs/verification/migration-candidate.sha256',
  'docs/verification/m1-baseline.sha256',
  'infra/docker/docker-compose.yml',
  'infra/docker/api.Dockerfile',
  'infra/docker/worker.Dockerfile'
)

foreach ($relative in $requiredFiles) {
  Assert-True (Test-Path -LiteralPath (Join-Path $root $relative) -PathType Leaf) "required file exists: $relative"
}

$requiredBuildOutputs = @(
  'apps/api/dist/main.js',
  'apps/worker/dist/main.js',
  'apps/admin/dist/index.html',
  'packages/contracts/dist/index.js',
  'packages/domain/dist/index.js',
  'packages/observability/dist/index.js',
  'packages/testing/dist/index.js'
)
foreach ($relative in $requiredBuildOutputs) {
  Assert-True (Test-Path -LiteralPath (Join-Path $root $relative) -PathType Leaf) "fresh build output exists: $relative"
}

$rootPackage = Read-Utf8 'package.json' | ConvertFrom-Json
Assert-True ($rootPackage.packageManager -eq 'pnpm@11.7.0') 'package manager is exactly pinned'
Assert-True ($rootPackage.engines.node -eq '>=22.13.0 <25') 'supported Node range is explicit'
Assert-True ($rootPackage.scripts.check -match 'verify:m1') 'full check includes M1 verification'
Assert-True ($rootPackage.scripts.check -match 'security:static') 'full check includes static security scanning'
Assert-True ($rootPackage.scripts.'db:status' -match '@campus/database db:status') 'root exposes the migration status gate'

$packageFiles = Get-ChildItem (Join-Path $root 'apps'), (Join-Path $root 'packages') -Filter package.json -File -Recurse
foreach ($file in $packageFiles) {
  $package = Get-Content -LiteralPath $file.FullName -Raw -Encoding utf8 | ConvertFrom-Json
  foreach ($sectionName in @('dependencies', 'devDependencies')) {
    $section = $package.$sectionName
    if ($null -ne $section) {
      foreach ($property in $section.PSObject.Properties) {
        $value = [string]$property.Value
        $isExact = ($value -match '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') -or ($value -match '^workspace:\*$')
        Assert-True $isExact "exact dependency: $($package.name) -> $($property.Name)@$value"
      }
    }
  }
}

$workspace = Read-Utf8 'pnpm-workspace.yaml'
Assert-True ($workspace -match "(?m)^\s*'@prisma/client': true\s*$") 'Prisma client lifecycle script is explicitly allowed'
Assert-True ($workspace -match "(?m)^\s*'@prisma/engines': true\s*$") 'Prisma engine lifecycle script is explicitly allowed'
Assert-True ($workspace -match '(?m)^\s*esbuild: true\s*$') 'esbuild lifecycle script is explicitly allowed'
Assert-True ($workspace -match '(?m)^\s*msgpackr-extract: false\s*$') 'optional native msgpack build is explicitly denied'
Assert-True ($workspace -match "(?m)^\s*'@prisma/config@6\.19\.2>effect': 3\.20\.0\s*$") 'audited Prisma transitive dependency is patched'

$lock = Read-Utf8 'pnpm-lock.yaml'
Assert-True ($lock -match 'lockfileVersion:') 'lockfile declares a version'
Assert-True ($lock -match 'effect@3\.20\.0') 'lockfile contains the patched effect version'
Assert-True (-not ($lock -match 'effect@3\.18\.4')) 'vulnerable effect version is absent from lockfile'

$schema = Read-Utf8 'packages/database/prisma/schema.prisma'
foreach ($model in @(
  'UserSession', 'UserContact', 'VerificationAsset', 'RouteSchedule', 'GroupMember',
  'FormationRound', 'MemberConfirmation', 'ServiceOrder', 'PaymentTransaction',
  'Refund', 'ContactConsent', 'ContactUnlock', 'ContactAccessLog',
  'VerificationAssetAccessGrant', 'BlockRelation', 'Notification', 'OutboxEvent'
)) {
  $modelMatch = [regex]::Match($schema, "(?sm)^model $model \{.*?^\}")
  Assert-True $modelMatch.Success "tenant model exists: $model"
  Assert-True ($modelMatch.Value -match '(?m)^\s+campusId\s+String\s+@db\.Uuid\s*$') "tenant model has required campusId: $model"
}
Assert-True (-not ($schema -match 'model\s+(Driver|Vehicle|Fare|TransportOrder)\s*\{|driverId|vehicleId|actualFare|transportStatus')) 'schema excludes transport-domain entities and fields'
Assert-True ($schema -match 'amountFen\s+Int\s+@default\(99\)') 'service fee is integer 99 fen'
Assert-True ($schema -match '(?s)enum VerificationStatus \{.*AWAITING_UPLOAD.*UPLOAD_EXPIRED.*REQUIRE_RESUBMISSION.*RESUBMISSION_AWAITING_UPLOAD.*RESUBMISSION_PENDING.*VERIFICATION_EXPIRED') 'schema models an unambiguous verification and resubmission lifecycle'
$verificationStatusBlock = [regex]::Match($schema, '(?sm)^enum VerificationStatus \{.*?^\}').Value
Assert-True (-not ($verificationStatusBlock -match '(?m)^\s+EXPIRED\s*$')) 'verification status excludes ambiguous EXPIRED'
Assert-True ($schema -match '(?s)enum GroupState \{.*REFUNDING.*REFUND_RETRY') 'schema models non-joinable refund states'
Assert-True ($schema -match 'model AdminSession \{') 'schema models independent administrator sessions'

$migrationDirectories = Get-ChildItem (Join-Path $root 'packages/database/prisma/migrations') -Directory
Assert-True ($migrationDirectories.Count -eq 1) 'pre-release workspace has exactly one migration candidate'
Assert-True ($migrationDirectories[0].Name -eq '20260715000000_m1_final_state_candidate') 'final-state migration candidate has the reviewed identity'
$migration = Read-Utf8 'packages/database/prisma/migrations/20260715000000_m1_final_state_candidate/migration.sql'
foreach ($guard in @(
  'GroupMember_campus_group_fkey',
  'ServiceOrder_campus_round_fkey',
  'TravelDemand_seat_count_check',
  'GroupMember_seat_count_check',
  'ServiceOrder_price_check',
  'ContactUnlock_distinct_users_check',
  'BlockRelation_distinct_users_check',
  'IdempotencyRecord_actor_check',
  'FormationRound_one_active_per_group_key',
  'GroupMember_group_seat_limit_trigger',
  'ContactAccessLog_outcome_check',
  'AdminSession_lifetime_check',
  'VerificationAssetAccessGrant_lifetime_check',
  'StudentVerification_state_time_check',
  'ContactAccessLog_disclosure_evidence_check'
)) {
  Assert-True ($migration.Contains($guard)) "database guard exists: $guard"
}
Assert-True ($migration -match 'occupied_seats \+ NEW\."seatCount" > 4') 'database trigger rejects a fifth active seat'
Assert-True ($migration -match '"amountFen" = 99') 'database check rejects forged service prices'
Assert-True ($migration -match 'CREATE TYPE "VerificationStatus" AS ENUM \(' -and $migration -match "'AWAITING_UPLOAD'.*'UPLOAD_EXPIRED'.*'VERIFICATION_EXPIRED'") 'candidate directly creates the final verification enum'
Assert-True ($migration -match 'CREATE TYPE "GroupState" AS ENUM \(' -and $migration -match "'REFUNDING'.*'REFUND_RETRY'") 'candidate directly creates the final group enum'
Assert-True (-not ($migration -match 'ALTER TYPE|ADD COLUMN')) 'candidate contains no historical enum or column upgrade steps'
Assert-True (-not ($migration -match 'original M1 snapshot|preceding migration|historical EXPIRED')) 'candidate contains no historical migration assumptions'
Assert-True (-not ($migration -match 'UPDATE "(?:StudentVerification|FormationRound|VerificationAsset)"')) 'candidate contains no empty-database backfill statements'
Assert-True ($migration -match 'Validation in a disposable isolated database is allowed') 'candidate permits native validation only in a disposable isolated database'
Assert-True ($migration -match 'contact-sharing-v1') 'migration locks the contact policy version'
Assert-True ($migration -match "'00000000-0000-0000-0000-00000000c001'" -and $migration -match "'0edb7bc14901dc477cae840e4e5dc5dd4d6933610f950f7f0999cc0fd89bf9b6'") 'empty-database candidate seeds the reviewed policy identity and digest directly'
Assert-True ($migration -match 'consume_verification_asset_access_grant') 'database exposes atomic asset-grant consumption'
Assert-True ($migration -match 'VerificationAssetAccessGrant_usedAt_immutable_trigger') 'database prevents consumed grant reuse'
Assert-True ($migration -match "INTERVAL '60 seconds'") 'database caps asset-grant lifetime at 60 seconds'
Assert-True ($migration -match '"expiresAt" > "reviewedAt"') 'database requires finite reviewed credential validity'

$migrationCandidatePath = Join-Path $root 'docs/verification/migration-candidate.sha256'
$migrationCandidateLines = Get-Content -LiteralPath $migrationCandidatePath -Encoding utf8 | Where-Object { $_ -match '^[a-f0-9]{64} \*' }
Assert-True ($migrationCandidateLines.Count -eq 1) 'migration candidate manifest contains exactly one fingerprint'
foreach ($line in $migrationCandidateLines) {
  $hash = $line.Substring(0, 64)
  $relative = $line.Substring(66)
  $candidate = Join-Path $root $relative
  Assert-True (Test-Path -LiteralPath $candidate -PathType Leaf) "migration candidate file exists: $relative"
  if (Test-Path -LiteralPath $candidate -PathType Leaf) {
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $candidate).Hash.ToLowerInvariant()
    Assert-True ($actual -eq $hash) "migration candidate digest matches: $relative"
  }
}

$resetDecision = Read-Utf8 'docs/verification/m1-database-reset-decision.md'
Assert-True ($resetDecision -match 'PENDING APPROVAL') 'database reset remains pending accountable owner approval'
Assert-True ($resetDecision.Contains('ProjectReleaseOwner: PENDING')) 'database reset has no self-declared project owner'
Assert-True (($resetDecision | Select-String -Pattern 'UNKNOWN' -AllMatches).Matches.Count -ge 6) 'external database environments remain explicitly unknown until inventoried'
Assert-True ($resetDecision.Contains('ApprovalSignature: PENDING')) 'database reset approval signature remains unfilled'
Assert-True ($resetDecision -match 'migration-candidate\.sha256') 'database reset decision identifies a candidate rather than a frozen baseline'

$openApi = Read-Utf8 'docs/api/openapi.yaml'
Assert-True ($openApi -match '(?m)^openapi: 3\.1\.0\s*$') 'OpenAPI 3.1 remains the contract source'
Assert-True ($openApi -match '(?m)^\s+identifier: LicenseRef-Proprietary\s*$') 'OpenAPI license metadata is explicit'
Assert-True ($openApi -match '(?m)^\s+operationId: getHealth\s*$') 'health endpoint is documented'
Assert-True ($openApi -match '(?m)^\s+operationId: revokeContactConsent\s*$') 'consent withdrawal is documented'
Assert-True ($openApi -match '(?m)^\s+operationId: issueVerificationAssetAccess\s*$') 'single-use admin asset access is documented'
Assert-True ($openApi -match '(?m)^\s+operationId: consumeVerificationAssetGrant\s*$') 'controlled admin asset proxy is documented'
Assert-True ($openApi -match '(?m)^\s+operationId: createResubmissionUpload\s*$') 'verification resubmission upload is documented'
foreach ($verificationSchema in @('VerificationVerified', 'VerificationRejected', 'VerificationRequiresResubmission', 'VerificationCredentialExpired')) {
  Assert-True ($openApi -match "(?m)^    $verificationSchema`:\s*$") "verification response branch exists: $verificationSchema"
}
Assert-True (-not ($openApi -match '(?m)^    VerificationReviewed:\s*$')) 'ambiguous reviewed verification response is absent'
Assert-True ($openApi -match '(?m)^\s+x-required-roles:') 'admin operation roles are contract metadata'
Assert-True ($openApi -match '(?m)^\s+additionalProperties: false\s*$') 'contract contains closed object schemas'

$apiCoverage = Read-Utf8 'apps/api/vitest.config.ts'
foreach ($metric in @('statements', 'branches', 'functions', 'lines')) {
  Assert-True ($apiCoverage -match "$metric\s*:\s*80") "API coverage threshold is at least 80 for $metric"
}
$domainCoverage = Read-Utf8 'packages/domain/vitest.config.ts'
foreach ($metric in @('statements', 'branches', 'functions', 'lines')) {
  Assert-True ($domainCoverage -match "$metric\s*:\s*90") "domain coverage threshold is at least 90 for $metric"
}

$observability = Read-Utf8 'packages/observability/src/index.ts'
foreach ($sensitivePath in @('authorization', 'refreshToken', 'wechatId', 'studentNumber', 'uploadUrl', 'grantToken', 'x-verification-asset-grant', 'objectKey')) {
  Assert-True ($observability -match [regex]::Escape($sensitivePath)) "logger redacts sensitive path: $sensitivePath"
}

$appJson = Read-Utf8 'apps/miniprogram/miniprogram/app.json' | ConvertFrom-Json
foreach ($page in $appJson.pages) {
  foreach ($extension in @('ts', 'json', 'wxml', 'wxss')) {
    $relative = "apps/miniprogram/miniprogram/$page.$extension"
    Assert-True (Test-Path -LiteralPath (Join-Path $root $relative) -PathType Leaf) "mini-program page artifact exists: $relative"
  }
}

$ci = Read-Utf8 '.github/workflows/ci.yml'
Assert-True ($ci -match 'postgres:16') 'CI uses a pinned PostgreSQL 16 service'
Assert-True ($ci -match 'redis:7\.4\.2-alpine') 'CI uses a pinned Redis 7 service'
Assert-True ($ci -match 'pnpm check') 'CI runs the full quality gate'
Assert-True ($ci -match 'NATIVE_POSTGRES_TESTS: "true"') 'CI enables native PostgreSQL integration tests'
Assert-True ($ci -match 'NATIVE_REDIS_TESTS: "true"') 'CI enables native Redis integration tests'
Assert-True ($ci -match 'pnpm audit --audit-level high') 'CI blocks high dependency vulnerabilities'
Assert-True ($ci -match 'pnpm db:migrate') 'CI invokes the database migration gate'
Assert-True (($ci | Select-String -Pattern 'pnpm db:migrate 2>&1' -AllMatches).Matches.Count -eq 2) 'CI deploys the migration twice to prove idempotency'
Assert-True ($ci -match 'pnpm db:status 2>&1') 'CI verifies Prisma migration status after both deploys'
$actionReferences = [regex]::Matches($ci, '(?m)^\s*uses:\s*([^\s#]+)') |
  ForEach-Object { $_.Groups[1].Value }
Assert-True ($actionReferences.Count -eq 4) 'CI uses only the four reviewed third-party Actions'
foreach ($actionReference in $actionReferences) {
  Assert-True ($actionReference -match '^[^@\s]+@[a-f0-9]{40}$') "CI Action is pinned to a full commit SHA: $actionReference"
}
Assert-True ($ci -match 'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683\s+# v4\.2\.2') 'checkout Action SHA matches reviewed v4.2.2 commit'
Assert-True ($ci -match 'pnpm/action-setup@a7487c7e89a18df4991f7f222e4898a00d66ddda\s+# v4\.1\.0') 'pnpm setup Action SHA matches reviewed v4.1.0 commit'
Assert-True ($ci -match 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020\s+# v4\.4\.0') 'Node setup Action SHA matches reviewed v4.4.0 commit'
Assert-True ($ci -match 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02\s+# v4\.6\.2') 'artifact Action SHA matches reviewed v4.6.2 commit'
Assert-True ($ci -match 'persist-credentials:\s*false') 'checkout does not persist repository credentials'
Assert-True ($ci -match 'tools/assert-native-vitest-report\.mjs .+ PostgreSQL 4') 'CI rejects skipped or incomplete native PostgreSQL evidence'
Assert-True ($ci -match 'tools/assert-native-vitest-report\.mjs .+ Redis 1') 'CI rejects skipped or incomplete native Redis evidence'
Assert-True ($ci -match 'Generate raw evidence manifest[\s\S]*if:\s*always\(\)') 'CI preserves an evidence manifest after failures'
Assert-True ($ci -match 'sha256sum > \.m1-evidence/sha256sums\.txt') 'CI records raw-byte SHA-256 evidence digests'
Assert-True ($ci -match 'if-no-files-found:\s*error') 'CI fails evidence upload when the artifact is missing'
Assert-True ($ci -match 'retention-days:\s*30') 'CI retains M1 evidence for 30 days'
$dependabot = Read-Utf8 '.github/dependabot.yml'
Assert-True ($dependabot -match 'package-ecosystem:\s*github-actions') 'Dependabot reviews GitHub Action commit updates'
Assert-True ($dependabot -match 'interval:\s*weekly') 'GitHub Action update review runs weekly'
$nativeReportAssertion = Read-Utf8 'tools/assert-native-vitest-report.mjs'
Assert-True ($nativeReportAssertion -match 'pendingTests !== 0') 'native evidence assertion rejects skipped tests'
Assert-True ($nativeReportAssertion -match 'passedTests !== counters\.totalTests') 'native evidence assertion requires every test to pass'
$databasePackage = Read-Utf8 'packages/database/package.json' | ConvertFrom-Json
Assert-True ($databasePackage.scripts.'db:migrate' -match 'prisma migrate deploy') 'database migration gate uses migrate deploy'
Assert-True ($databasePackage.scripts.'db:status' -match 'prisma migrate status') 'database status gate uses migrate status'
$nativePostgresTest = Read-Utf8 'packages/database/test/native-postgres.e2e.test.ts'
Assert-True ($nativePostgresTest -match 'attempt <= 20') 'native PostgreSQL seat race repeats 20 rounds'
Assert-True ($nativePostgresTest -match 'grantAttempt <= 20') 'native PostgreSQL grant race repeats 20 rounds'
$pgliteMigrationTest = Read-Utf8 'packages/database/test/migration.e2e.test.ts'
$databaseObjectInventory = Read-Utf8 'packages/database/test/database-object-inventory.ts'
Assert-True ($nativePostgresTest -match 'matches the shared final database object inventory') 'native PostgreSQL runs the shared object inventory test'
Assert-True ($nativePostgresTest -match 'databaseObjectInventorySql' -and $nativePostgresTest -match 'expectedDatabaseObjectInventory') 'native PostgreSQL consumes the shared inventory query and expectations'
Assert-True ($pgliteMigrationTest -match 'databaseObjectInventorySql' -and $pgliteMigrationTest -match 'expectedDatabaseObjectInventory') 'PGlite consumes the same shared inventory query and expectations'
foreach ($catalog in @('pg_enum', 'pg_constraint', 'pg_proc', 'pg_trigger')) {
  Assert-True ($databaseObjectInventory -match $catalog) "shared object inventory queries catalog: $catalog"
}
foreach ($objectName in @(
  'GroupMember_campus_group_fkey',
  'ServiceOrder_campus_round_fkey',
  'StudentVerification_state_time_check',
  'ContactAccessLog_disclosure_evidence_check',
  'VerificationAssetAccessGrant_lifetime_check',
  'GroupMember_group_seat_limit_trigger',
  'VerificationAssetAccessGrant_usedAt_immutable_trigger',
  'enforce_group_seat_limit',
  'consume_verification_asset_access_grant'
)) {
  Assert-True ($databaseObjectInventory -match [regex]::Escape($objectName)) "shared object inventory includes: $objectName"
}

$baselinePath = Join-Path $root 'docs/verification/m1-baseline.sha256'
if (Test-Path -LiteralPath $baselinePath -PathType Leaf) {
  $baselineLines = Get-Content -LiteralPath $baselinePath -Encoding utf8 | Where-Object { $_ -match '^[a-f0-9]{64} \*' }
  Assert-True ($baselineLines.Count -ge 12) 'M1 baseline covers engineering, migration and security evidence files'
  foreach ($line in $baselineLines) {
    $hash = $line.Substring(0, 64)
    $relative = $line.Substring(66)
    $candidate = Join-Path $root $relative
    Assert-True (Test-Path -LiteralPath $candidate -PathType Leaf) "M1 baseline file exists: $relative"
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $candidate).Hash.ToLowerInvariant()
      Assert-True ($actual -eq $hash) "M1 baseline digest matches: $relative"
    }
  }
}

$allSourceText = Get-ChildItem (Join-Path $root 'apps'), (Join-Path $root 'packages'), (Join-Path $root 'infra'), (Join-Path $root 'docs') -File -Recurse |
  Where-Object { $_.FullName -notmatch '\\(dist|coverage|generated)\\' } |
  ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw -Encoding utf8 }
$joinedSource = $allSourceText -join "`n"
Assert-True (-not ($joinedSource -match '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----')) 'repository contains no private key material'
Assert-True (-not ($joinedSource -match 'sk-[A-Za-z0-9_-]{20,}')) 'repository contains no API key-shaped secret'
Assert-True (-not ($joinedSource -match '(?m)^(?:JWT_SECRET|WECHAT_APP_SECRET|WECHAT_API_V3_KEY|CONTACT_ENCRYPTION_KEY)=.+$')) 'repository contains no populated application secret'
Assert-True (-not ($joinedSource -match 'console\.(?:log|debug)\(')) 'application source contains no unstructured debug logging'

if (-not $Quiet) {
  Write-Host ""
  Write-Host "M1 checks: $($passes.Count) passed, $($failures.Count) failed"
}

if ($failures.Count -gt 0) {
  throw "M1 verification failed: $($failures -join '; ')"
}
