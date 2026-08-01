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

function Get-CanonicalFileSha256([string]$LiteralPath) {
  [byte[]]$bytes = [System.IO.File]::ReadAllBytes($LiteralPath)
  $canonical = [System.Collections.Generic.List[byte]]::new($bytes.Length)
  for ($index = 0; $index -lt $bytes.Length; $index++) {
    if ($bytes[$index] -eq 13) {
      if (($index + 1) -lt $bytes.Length -and $bytes[$index + 1] -eq 10) { $index++ }
      $canonical.Add(10)
    } else {
      $canonical.Add($bytes[$index])
    }
  }
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try { $digest = $sha256.ComputeHash($canonical.ToArray()) } finally { $sha256.Dispose() }
  return -join ($digest | ForEach-Object { $_.ToString('x2') })
}

$requiredFiles = @(
  'docs/verification/m2-entry-approval.md',
  'docs/verification/m2-invariants.md',
  'docs/verification/milestone-m2.md',
  'docs/verification/m2-baseline.sha256',
  'docs/policies/sensitive-information-v1.md',
  'packages/auth/src/index.ts',
  'packages/auth/test/index.test.ts',
  'packages/verification/src/index.ts',
  'packages/verification/test/object-store.test.ts',
  'apps/api/src/bootstrap.ts',
  'apps/api/src/auth/auth.service.ts',
  'apps/api/src/m2/idempotency.service.ts',
  'apps/api/src/verification/verification.service.ts',
  'apps/api/src/admin/admin-auth.service.ts',
  'apps/api/src/admin/admin-verification.service.ts',
  'apps/api/test/health.e2e.test.ts',
  'apps/api/test/idempotency.service.test.ts',
  'apps/api/test/native-m2.e2e.test.ts',
  'apps/worker/src/verification-asset-deletion.ts',
  'apps/worker/test/verification-asset-deletion.test.ts',
  'apps/admin/src/App.tsx',
  'apps/miniprogram/miniprogram/pages/student-verification/index.ts',
  'tools/bootstrap-admin.mjs',
  'tools/verify-m2.ps1',
  'packages/database/prisma/migrations/20260731000000_m2_sensitive_info_policy/migration.sql'
)
foreach ($relative in $requiredFiles) {
  Assert-True (Test-Path -LiteralPath (Join-Path $root $relative) -PathType Leaf) "required M2 file exists: $relative"
}

$entryApproval = Read-Utf8 'docs/verification/m2-entry-approval.md'
Assert-True ($entryApproval -match 'M0') 'M2 entry records final M0 confirmation'
Assert-True ($entryApproval -match 'M1.*M2') 'M2 entry records M1 acceptance and M2 start'
Assert-True ($entryApproval -match 'Cedric') 'M2 entry records accountable approver'

$migrationsRoot = Join-Path $root 'packages/database/prisma/migrations'
$migrationDirectories = Get-ChildItem -LiteralPath $migrationsRoot -Directory | Sort-Object Name
Assert-True ($migrationDirectories.Count -ge 2) 'M2 history retains the immutable M1 and additive M2 migrations'
$m1Migration = Join-Path $migrationsRoot '20260715000000_m1_final_state_candidate/migration.sql'
$m1Digest = (Get-FileHash -Algorithm SHA256 -LiteralPath $m1Migration).Hash.ToLowerInvariant()
Assert-True ($m1Digest -eq '6d893aa089650d72b717546960679aad1f3f61abe8b32ba07ed2a623ad605902') 'released M1 migration raw bytes remain immutable'
$policyPath = Join-Path $root 'docs/policies/sensitive-information-v1.md'
$policyDigest = (Get-FileHash -Algorithm SHA256 -LiteralPath $policyPath).Hash.ToLowerInvariant()
Assert-True ($policyDigest -eq '46035097382e2f7435307106825cc0f2cc2a94a98e767b597a48488ee73918a7') 'reviewed sensitive-information policy digest matches the release value'
$m2Migration = Read-Utf8 'packages/database/prisma/migrations/20260731000000_m2_sensitive_info_policy/migration.sql'
Assert-True ($m2Migration -match [regex]::Escape($policyDigest)) 'M2 migration binds the exact reviewed policy digest'
Assert-True ($m2Migration -match 'sensitive-info-v1') 'M2 migration registers the public consent version'
Assert-True ($m2Migration -match 'VerificationAssetType') 'M2 migration adds independently typed verification evidence'
Assert-True ($m2Migration -match 'verificationAssetId') 'M2 grants bind the exact verification asset'
Assert-True ($m2Migration -match 'deletionClaimedAt') 'M2 migration supports race-safe deletion claims'
Assert-True (-not ($m2Migration -match 'UPDATE\s+"(?:StudentVerification|PolicyVersion)"')) 'M2 migration does not rewrite historical verification or policy rows'

$authPackage = Read-Utf8 'packages/auth/src/index.ts'
foreach ($guard in @('argon2id', 'memorySize: 65_536', 'iterations: 3', 'verifyTotpCode', 'timingSafeEqual', 'AesGcmProtector')) {
  Assert-True ($authPackage -match [regex]::Escape($guard)) "authentication primitive exists: $guard"
}
$authPackageJson = Read-Utf8 'packages/auth/package.json' | ConvertFrom-Json
Assert-True ($authPackageJson.dependencies.'hash-wasm' -eq '4.12.0') 'Argon2 dependency is exactly pinned'

$verificationPackage = Read-Utf8 'packages/verification/src/index.ts'
Assert-True ($verificationPackage -match 'INVALID_IMAGE_SIGNATURE') 'verification storage rejects header-only image spoofing'
Assert-True ($verificationPackage -match 'aes-256-gcm') 'verification upload grants encrypt their private object binding'
Assert-True ($verificationPackage -match 'UPLOAD_TOKEN_CONTEXT') 'verification upload grants are context bound'
Assert-True ($verificationPackage -match 'flag: "wx"') 'private verification objects cannot be silently overwritten'

$bootstrap = Read-Utf8 'apps/api/src/bootstrap.ts'
Assert-True ($bootstrap -match 'maxParamLength:\s*512') 'encrypted upload token route has a bounded 512 character limit'
$idempotency = Read-Utf8 'apps/api/src/m2/idempotency.service.ts'
Assert-True ($idempotency -match 'SERIALIZABLE_TRANSACTION_ATTEMPTS = 3') 'serializable transaction retry count is bounded at three'
Assert-True ($idempotency -match 'error\.code === "P2034"') 'serializable transaction conflicts are identified explicitly'
$routerRegression = Read-Utf8 'apps/api/test/health.e2e.test.ts'
Assert-True ($routerRegression -match 'token\.length\)\.toBeGreaterThan\(100\)') 'router regression test exceeds the framework default parameter limit'
Assert-True ($routerRegression -match 'response\.statusCode\)\.toBe\(204\)') 'router regression test proves encrypted upload delivery'
$retryRegression = Read-Utf8 'apps/api/test/idempotency.service.test.ts'
Assert-True ($retryRegression -match 'toHaveBeenCalledTimes\(3\)') 'retry regression test proves the bounded exhaustion path'

$adminAuth = Read-Utf8 'apps/api/src/admin/admin-auth.service.ts'
foreach ($guard in @('CSRF_GRACE_LIFETIME_MS', 'admin-csrf-current', 'admin-csrf-grace', 'verifyReauthenticationTotp')) {
  Assert-True ($adminAuth -match [regex]::Escape($guard)) "administrator security guard exists: $guard"
}
$adminVerification = Read-Utf8 'apps/api/src/admin/admin-verification.service.ts'
Assert-True ($adminVerification -match 'VERIFICATION_REVIEWER') 'verification review requires the dedicated administrator role'
Assert-True ($adminVerification -match 'verification-asset-grant-binding') 'material grant binds the exact object version'
Assert-True ($adminVerification -match 'consume_verification_asset_access_grant') 'material grant consumption uses the atomic database function'
Assert-True ($adminVerification -match 'verificationAssetId') 'material grant names the exact typed asset row'

$worker = Read-Utf8 'apps/worker/src/verification-asset-deletion.ts'
Assert-True ($worker -match 'claimAsset\(asset\.id, asset\.objectKey') 'material deletion claims the exact row before external deletion'
Assert-True ($worker -match 'releaseAssetClaim') 'failed external deletion releases its retryable claim'
Assert-True ($worker -match 'markAssetDeleted\(asset\.id, asset\.objectKey') 'material deletion uses object-key compare-and-set after storage deletion'
Assert-True ($worker -match 'VERIFICATION_ASSET_DELETE_OBJECT') 'resubmission deletes the exact superseded object'
Assert-True ($worker -match 'markEventFailed') 'failed external deletion enters a retry path'

$nativeApi = Read-Utf8 'apps/api/test/native-m2.e2e.test.ts'
Assert-True ($nativeApi -match 'attempt < 20') 'student identity race repeats 20 rounds'
Assert-True ($nativeApi -match 'refresh family on a race') 'native API tests cover refresh replay revocation'
Assert-True ($nativeApi -match 'single-use material access') 'native API tests cover controlled material delivery'
$databaseMigrationTest = Read-Utf8 'packages/database/test/migration.e2e.test.ts'
Assert-True ($databaseMigrationTest -match 'M1 snapshot without rewriting existing rows') 'M2 migration is tested against an M1 snapshot'

$apiCoverage = Read-Utf8 'apps/api/vitest.config.ts'
foreach ($metric in @('statements', 'branches', 'functions', 'lines')) {
  Assert-True ($apiCoverage -match "$metric\s*:\s*80") "API $metric coverage threshold remains 80 percent"
}
$authCoverage = Read-Utf8 'packages/auth/vitest.config.ts'
foreach ($metric in @('statements', 'branches', 'functions', 'lines')) {
  Assert-True ($authCoverage -match "$metric\s*:\s*90") "authentication $metric coverage threshold is 90 percent"
}

$observability = Read-Utf8 'packages/observability/src/index.ts'
foreach ($field in @('password', 'totpCode', 'reauthTotpCode', 'csrfToken', 'sessionToken', 'studentNumber', 'objectKey')) {
  Assert-True ($observability -match [regex]::Escape($field)) "logs redact M2 sensitive field: $field"
}

$ci = Read-Utf8 '.github/workflows/ci.yml'
Assert-True ($ci -match 'native-m2\.e2e\.test\.ts') 'CI runs native M2 API tests explicitly'
Assert-True ($ci -match 'M2-API 3') 'CI rejects skipped or incomplete native M2 API evidence'
Assert-True ($ci -match '\.m2-evidence/sha256sums\.txt') 'CI produces a raw M2 evidence manifest'
Assert-True ($ci -match 'm2-verification-') 'CI publishes a milestone-scoped M2 evidence artifact'

$rootPackage = Read-Utf8 'package.json' | ConvertFrom-Json
Assert-True ($rootPackage.scripts.check -match 'verify:m1' -and $rootPackage.scripts.check -match 'verify:m2') 'full gate preserves M1 and M2 verification'
Assert-True ($rootPackage.scripts.'admin:bootstrap' -match 'bootstrap-admin\.mjs') 'repository exposes the one-time administrator bootstrap command'

$baselinePath = Join-Path $root 'docs/verification/m2-baseline.sha256'
if (Test-Path -LiteralPath $baselinePath -PathType Leaf) {
  $baselineManifestDigest = (Get-FileHash -Algorithm SHA256 -LiteralPath $baselinePath).Hash.ToLowerInvariant()
  Assert-True (
    $baselineManifestDigest -eq 'fcda2906374de265e9f833efe682bcb9a68822d0dee18738bc6c62ccc0cc28f9'
  ) 'historical M2 baseline manifest itself remains byte-for-byte immutable'
  $baselineLines = Get-Content -LiteralPath $baselinePath -Encoding utf8 | Where-Object { $_ -match '^[a-f0-9]{64} \*' }
  Assert-True ($baselineLines.Count -ge 20) 'M2 baseline covers implementation, tests, policy, migration and evidence report'
  foreach ($acceptedEntry in @(
    'fb8e9e49d97db759d8eb441ff2f89e6dd54c13e3a4bb35eab350c4f807e5a681 *packages/database/prisma/migrations/20260731000000_m2_sensitive_info_policy/migration.sql',
    '46035097382e2f7435307106825cc0f2cc2a94a98e767b597a48488ee73918a7 *docs/policies/sensitive-information-v1.md',
    'c1b5df9cd9e9a82147c9a4f41e69d92a5eb419f4432ff2a3a4c940fe3097e377 *docs/verification/milestone-m2.md',
    'afb0a2593f69ce24624a3394b4e4a0aa7f4784619d48f997d5264e66bd0d053f *tools/verify-m2.ps1'
  )) {
    Assert-True ($baselineLines -contains $acceptedEntry) "historical M2 baseline retains accepted entry: $($acceptedEntry.Substring(66))"
  }
}

if (-not $Quiet) {
  Write-Host ""
  Write-Host "M2 checks: $($passes.Count) passed, $($failures.Count) failed"
}
if ($failures.Count -gt 0) { throw "M2 verification failed: $($failures -join '; ')" }
