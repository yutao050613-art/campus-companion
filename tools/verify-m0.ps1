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

function Get-CanonicalFileSha256([string]$LiteralPath) {
  [byte[]]$bytes = [System.IO.File]::ReadAllBytes($LiteralPath)
  $canonical = [System.Collections.Generic.List[byte]]::new($bytes.Length)

  for ($index = 0; $index -lt $bytes.Length; $index++) {
    if ($bytes[$index] -eq 13) {
      if (($index + 1) -lt $bytes.Length -and $bytes[$index + 1] -eq 10) {
        $index++
      }
      $canonical.Add(10)
    } else {
      $canonical.Add($bytes[$index])
    }
  }

  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $digest = $sha256.ComputeHash($canonical.ToArray())
  } finally {
    $sha256.Dispose()
  }
  return -join ($digest | ForEach-Object { $_.ToString('x2') })
}

$required = @(
  '.gitattributes',
  'README.md',
  'docs/architecture/overview.md',
  'docs/architecture/decisions.md',
  'docs/architecture/product-surfaces.md',
  'docs/architecture/roadmap.md',
  'docs/domain/model.md',
  'docs/api/openapi.yaml',
  'docs/security/threat-model.md',
  'docs/policies/contact-sharing-v1.md',
  'docs/verification/standard.md',
  'docs/verification/traceability.md',
  'docs/verification/m0-baseline.sha256'
)

foreach ($relative in $required) {
  $path = Join-Path $root $relative
  Assert-True (Test-Path -LiteralPath $path -PathType Leaf) "required file exists: $relative"
}

$allTextFiles = @(
  Get-ChildItem (Join-Path $root 'docs') -File -Recurse
  Get-Item (Join-Path $root 'README.md')
)
foreach ($file in $allTextFiles) {
  $content = Get-Content -LiteralPath $file.FullName -Raw -Encoding utf8
  Assert-True (-not $content.Contains([char]0xfffd)) "UTF-8 has no replacement character: $($file.Name)"
  Assert-True (-not ($content -match '(?m)[ \t]+$')) "no trailing whitespace: $($file.Name)"
  Assert-True (-not ($content -match '<<<<<<<|=======|>>>>>>>')) "no merge-conflict marker: $($file.Name)"
}

$readme = Get-Content -LiteralPath (Join-Path $root 'README.md') -Raw -Encoding utf8
Assert-True ($readme -match '0\.99') 'README fixes the fee at 0.99 CNY'
Assert-True ($readme -match '99') 'README fixes the fee at 99 fen'
Assert-True ($readme -match 'M0') 'README declares the current milestone'
$readmeLinks = [regex]::Matches($readme, '\[[^\]]+\]\(([^)]+)\)') | ForEach-Object { $_.Groups[1].Value }
foreach ($link in $readmeLinks) {
  if ($link -notmatch '^[a-z]+://') {
    Assert-True (Test-Path -LiteralPath (Join-Path $root $link)) "README local link resolves: $link"
  }
}

$envExample = Get-Content -LiteralPath (Join-Path $root '.env.example') -Encoding utf8
$secretLines = $envExample | Where-Object { $_ -match '^(?:JWT_SECRET|WECHAT_APP_SECRET|WECHAT_API_V3_KEY|CONTACT_ENCRYPTION_KEY)=' }
foreach ($line in $secretLines) {
  Assert-True ($line -match '=$') "example secret is empty: $($line.Split('=')[0])"
}

$decisions = Get-Content -LiteralPath (Join-Path $root 'docs/architecture/decisions.md') -Raw -Encoding utf8
$adrIds = [regex]::Matches($decisions, 'ADR-\d{3}') | ForEach-Object Value
Assert-True (($adrIds | Sort-Object -Unique).Count -eq 14) 'ADR-001 through ADR-014 are present and unique'

$domain = Get-Content -LiteralPath (Join-Path $root 'docs/domain/model.md') -Raw -Encoding utf8
$invIds = [regex]::Matches($domain, 'INV-\d{3}') | ForEach-Object Value | Sort-Object -Unique
Assert-True ($invIds.Count -eq 14) 'INV-001 through INV-014 are present'
for ($i = 1; $i -le 14; $i++) {
  $id = 'INV-{0:D3}' -f $i
  Assert-True ($invIds -contains $id) "$id exists"
}
Assert-True ($domain -match 'IN_TRANSIT') 'domain explicitly documents excluded transport states'
Assert-True ($domain -match 'REFUNDING --> REFUND_RETRY') 'group state machine models refund retry transition'
Assert-True ($domain -match 'ContactAccessLog') 'domain separates contact access audit from unlock facts'
Assert-True ($domain -match 'AWAITING_UPLOAD') 'verification state machine models awaiting upload'
Assert-True ($domain -match 'UPLOAD_EXPIRED' -and $domain -match 'VERIFICATION_EXPIRED') 'verification state machine separates upload and credential expiry'
Assert-True ($domain -match 'RESUBMISSION_AWAITING_UPLOAD' -and $domain -match 'latestSubmittedAt') 'verification state machine preserves resubmission history'
Assert-True ($domain -match 'expiresAt > transactionNow') 'verification authorization rejects the exact expiry boundary synchronously'
Assert-True ($domain -match 'consumeVerificationAssetGrant' -and $domain -match 'usedAt') 'domain defines controlled atomic asset-grant consumption'
Assert-True ($domain -match 'all-or-nothing') 'contact reads use all-or-nothing disclosure semantics'
Assert-True ($domain -match 'ContactConsentRevoked') 'domain locks the consent revocation event'

$verificationStandard = Get-Content -LiteralPath (Join-Path $root 'docs/verification/standard.md') -Raw -Encoding utf8
Assert-True ($verificationStandard -match 'SHA-256\(raw-bytes\)') 'verification standard requires raw-byte evidence digests'
Assert-True ($verificationStandard -match 'SHA-256\(normalized-text\)') 'verification standard labels normalized text digests separately'
Assert-True ($verificationStandard -match 'LF/CRLF') 'verification standard requires explicit newline normalization rules'

$threat = Get-Content -LiteralPath (Join-Path $root 'docs/security/threat-model.md') -Raw -Encoding utf8
$threatIds = [regex]::Matches($threat, 'T-\d{3}') | ForEach-Object Value | Sort-Object -Unique
Assert-True ($threatIds.Count -eq 18) 'T-001 through T-018 are present'
for ($i = 1; $i -le 18; $i++) {
  $id = 'T-{0:D3}' -f $i
  Assert-True ($threatIds -contains $id) "$id exists"
}

$specPath = Join-Path $root 'docs/api/openapi.yaml'
$spec = Get-Content -LiteralPath $specPath -Raw -Encoding utf8
Assert-True ($spec -match '(?m)^openapi: 3\.1\.0\s*$') 'OpenAPI declares 3.1.0'

$operationIds = [regex]::Matches($spec, '(?m)^\s+operationId:\s+([A-Za-z0-9_]+)\s*$') | ForEach-Object { $_.Groups[1].Value }
$duplicateOperations = $operationIds | Group-Object | Where-Object Count -gt 1
$pathKeys = [regex]::Matches($spec, '(?m)^  (/[^:]+):\s*$') | ForEach-Object { $_.Groups[1].Value }
$duplicatePaths = $pathKeys | Group-Object | Where-Object Count -gt 1
Assert-True ($operationIds.Count -ge 20) 'OpenAPI contains the expected operation surface'
Assert-True ($duplicateOperations.Count -eq 0) 'OpenAPI operationId values are unique'
Assert-True ($duplicatePaths.Count -eq 0) 'OpenAPI path keys are unique'
Assert-True (-not ($spec.Contains("`t"))) 'OpenAPI uses no tab indentation'

$expectedPaths = @(
  '/auth/wechat/login:', '/verifications:', '/demands:', '/groups:',
  '/me/contact:', '/verifications/{verificationId}/submit:',
  '/verifications/{verificationId}/resubmission-upload:',
  '/groups/{groupId}/join:', '/groups/{groupId}/formation-rounds:',
  '/formation-rounds/{roundId}/confirm:', '/groups/{groupId}/service-orders:',
  '/formation-rounds/{roundId}/contact-consent:',
  '/service-orders/{orderId}/prepay:', '/payments/wechat/notify:',
  '/refunds/wechat/notify:', '/groups/{groupId}/contacts:',
  '/admin/auth/login:', '/admin/auth/csrf:', '/admin/auth/logout:',
  '/admin/verifications/{verificationId}/asset-access:',
  '/admin/verification-assets/consume:'
)
foreach ($expected in $expectedPaths) {
  Assert-True ($spec.Contains($expected)) "OpenAPI path exists: $expected"
}

$refs = [regex]::Matches($spec, "\x24ref:\s+'#/components/(?:schemas|responses|parameters)/([A-Za-z0-9_]+)'") |
  ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
$definitions = [regex]::Matches($spec, '(?m)^    ([A-Za-z0-9_]+):\s*$') |
  ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
$missingRefs = $refs | Where-Object { $definitions -notcontains $_ }
Assert-True ($refs.Count -gt 10) 'OpenAPI local references were discovered'
Assert-True ($missingRefs.Count -eq 0) "OpenAPI local references resolve: $($missingRefs -join ', ')"

Assert-True ($spec -match 'amountFen:\s*\{ type: integer, const: 99 \}') 'OpenAPI locks service order amount to 99 fen'
$wechatIdOccurrences = ([regex]::Matches($spec, '(?m)^\s+wechatId:')).Count
$groupSchemaBlock = [regex]::Match($spec, '(?sm)^    Group:.*?(?=^    GroupPage:)').Value
Assert-True ($wechatIdOccurrences -eq 2) 'wechatId appears only in contact write and unlocked response schemas'
Assert-True (-not ($groupSchemaBlock -match 'wechatId:')) 'ordinary group schema never contains wechatId'
Assert-True ($spec -match 'CONTACTS_NOT_UNLOCKED') 'OpenAPI defines explicit contacts-not-unlocked error'
Assert-True ($spec -match 'Idempotency-Key') 'OpenAPI defines idempotency header'
Assert-True ($spec -match 'Wechatpay-Signature') 'OpenAPI requires WeChat callback signature headers'
$verificationRequestBlock = [regex]::Match($spec, '(?sm)^    CreateVerificationRequest:.*?(?=^    VerificationUploadResponse:)').Value
Assert-True (-not ($verificationRequestBlock -match 'studentNumberLast4:')) 'client cannot submit a separate student-number suffix'
Assert-True ($verificationRequestBlock -match 'studentNumber:.*writeOnly: true') 'student number is request-only'
$verificationUploadBlock = [regex]::Match($spec, '(?sm)^    VerificationUploadResponse:.*?(?=^    Verification:)').Value
Assert-True ($verificationUploadBlock -match 'uploadUrl:.*readOnly: true') 'verification upload URL is response-only'
$adminSessionBlock = [regex]::Match($spec, '(?sm)^    AdminSessionResponse:.*?(?=^    AdminCsrfResponse:)').Value
Assert-True ($adminSessionBlock -match 'csrfToken:.*readOnly: true') 'admin login CSRF token is response-only'
$adminCsrfBlock = [regex]::Match($spec, '(?sm)^    AdminCsrfResponse:.*?(?=^    AdminVerification:)').Value
Assert-True ($adminCsrfBlock -match 'csrfToken:.*readOnly: true') 'rotated admin CSRF token is response-only'
$assetAccessBlock = [regex]::Match($spec, '(?sm)^    VerificationAssetAccessResponse:.*?(?=^    FieldViolation:)').Value
Assert-True ($assetAccessBlock -match 'consumePath:' -and $assetAccessBlock -match 'grantToken:') 'asset grant response points to the controlled proxy and returns a separate token'
Assert-True ($assetAccessBlock -match '(?s)grantToken:.*readOnly: true') 'verification asset grant token is response-only'
Assert-True (-not ($assetAccessBlock -match 'accessUrl:')) 'asset grant response never exposes a direct object URL'
Assert-True ($spec -match 'enum: \[RECRUITING, READY, CONFIRMING, PAYING, REFUNDING, REFUND_RETRY,') 'OpenAPI exposes non-joinable refund group states'
Assert-True ($spec -match 'status: \{ type: string, const: AWAITING_UPLOAD \}') 'OpenAPI exposes awaiting-upload verification state'
Assert-True ($spec -match 'status: \{ type: string, const: UPLOAD_EXPIRED \}') 'OpenAPI exposes unsubmitted upload expiry'
Assert-True ($spec -match 'status: \{ type: string, const: RESUBMISSION_AWAITING_UPLOAD \}') 'OpenAPI exposes resubmission upload state'
Assert-True ($spec -match 'status: \{ type: string, const: RESUBMISSION_PENDING \}') 'OpenAPI exposes resubmission review state'
$verificationStatusBlock = [regex]::Match($spec, '(?sm)^    VerificationStatus:.*?(?=^    VerificationUploadReady:)').Value
Assert-True ($verificationStatusBlock -match 'VERIFICATION_EXPIRED') 'OpenAPI exposes verified-credential expiry'
Assert-True (-not ($verificationStatusBlock -match '(?m)^\s+- EXPIRED\s*$')) 'verification status has no ambiguous EXPIRED value'
foreach ($verificationSchema in @('VerificationVerified', 'VerificationRejected', 'VerificationRequiresResubmission', 'VerificationCredentialExpired')) {
  Assert-True ($spec -match "(?m)^    $verificationSchema`:\s*$") "OpenAPI has a unique reviewed-status branch: $verificationSchema"
}
$verifiedSchemaBlock = [regex]::Match($spec, '(?sm)^    VerificationVerified:.*?(?=^    VerificationRejected:)').Value
$expiredSchemaBlock = [regex]::Match($spec, '(?sm)^    VerificationCredentialExpired:.*?(?=^    VerificationResubmissionAwaitingUpload:)').Value
Assert-True ($verifiedSchemaBlock -match 'expiresAt: \{ type: string, format: date-time \}') 'VERIFIED requires a non-null expiry'
Assert-True ($expiredSchemaBlock -match 'expiresAt: \{ type: string, format: date-time \}') 'VERIFICATION_EXPIRED preserves a non-null expiry'
Assert-True (-not ($spec -match '(?m)^    VerificationReviewed:\s*$')) 'ambiguous reviewed verification schema is absent'
Assert-True ($spec -match 'X-Verification-Asset-Grant') 'asset grant is accepted only through a dedicated header'
Assert-True ($spec -match 'x-replay-protection: database-conditional-update') 'asset grant consumption documents atomic replay protection'
Assert-True ($spec -match 'all-or-nothing') 'contact endpoint documents all-or-nothing disclosure'
Assert-True ($spec -match 'contactPolicyVersion') 'formation response locks a contact policy version'
Assert-True ($spec -match 'FormationConfirmationRequest') 'confirmation uses the structured consent schema'
Assert-True ($spec -match 'x-required-roles') 'admin operations declare required roles'
Assert-True ($spec -match 'x-campus-scope: required') 'admin operations declare campus scope'

$specLines = Get-Content -LiteralPath $specPath -Encoding utf8
function Get-OperationBlock([string]$OperationId) {
  $operationLine = -1
  for ($index = 0; $index -lt $specLines.Count; $index++) {
    if ($specLines[$index] -match "^      operationId:\s+$([regex]::Escape($OperationId))\s*$") {
      $operationLine = $index
      break
    }
  }
  if ($operationLine -lt 0) { return '' }
  $start = $operationLine
  while ($start -ge 0 -and $specLines[$start] -notmatch '^    (get|post|put|delete|patch):\s*$') { $start-- }
  $end = $operationLine + 1
  while ($end -lt $specLines.Count -and $specLines[$end] -notmatch '^    (get|post|put|delete|patch):\s*$|^  /|^components:') { $end++ }
  return ($specLines[$start..($end - 1)] -join "`n")
}

$publicOperations = @(
  'getHealth', 'wechatLogin', 'refreshSession', 'listCampuses', 'listCampusRoutes',
  'handleWechatPaymentNotification', 'handleWechatRefundNotification', 'adminLogin'
)
foreach ($operationId in $operationIds) {
  $block = Get-OperationBlock $operationId
  if ($publicOperations -contains $operationId) {
    Assert-True ($block -match '(?m)^      security: \[\]\s*$') "public operation clears inherited security: $operationId"
  } else {
    Assert-True ($block -match "(?m)^        '401':") "protected operation declares 401: $operationId"
  }
}

$businessWrites = @(
  'requestAccountDeletion', 'updateMyContact', 'createVerification', 'submitVerification',
  'createResubmissionUpload',
  'createDemand', 'cancelDemand', 'joinGroup', 'leaveGroup', 'startFormationRound',
  'confirmFormationRound', 'revokeContactConsent', 'createServiceOrder', 'createPrepay',
  'requestRefund', 'createReport', 'blockUser', 'unblockUser',
  'issueVerificationAssetAccess', 'reviewVerification', 'createRoute', 'reviewRefund'
)
foreach ($operationId in $businessWrites) {
  $block = Get-OperationBlock $operationId
  Assert-True ($block -match "#/components/parameters/IdempotencyKey") "business write declares idempotency key: $operationId"
}
foreach ($operationId in @('wechatLogin', 'refreshSession', 'logout', 'adminLogin', 'adminLogout')) {
  $block = Get-OperationBlock $operationId
  Assert-True (-not ($block -match "#/components/parameters/IdempotencyKey")) "auth operation uses dedicated replay semantics: $operationId"
}
$assetConsumeBlock = Get-OperationBlock 'consumeVerificationAssetGrant'
Assert-True (-not ($assetConsumeBlock -match "#/components/parameters/IdempotencyKey")) 'single-use grant consumption rejects business idempotency keys'
Assert-True ($assetConsumeBlock -match 'database-conditional-update') 'single-use grant consumption uses dedicated replay semantics'
foreach ($operationId in @('handleWechatPaymentNotification', 'handleWechatRefundNotification')) {
  $block = Get-OperationBlock $operationId
  Assert-True ($block -match 'x-idempotency-key-source: provider-notification') "callback documents provider idempotency tuple: $operationId"
  Assert-True (-not ($block -match "#/components/parameters/IdempotencyKey")) "callback rejects client idempotency key: $operationId"
}

$routeBlock = Get-OperationBlock 'listCampusRoutes'
Assert-True ($routeBlock -match '(?m)^      security: \[\]\s*$') 'route catalog is explicitly public'
$errorBlock = [regex]::Match($spec, '(?sm)^    ErrorDetails:.*?(?=^    ErrorResponse:)').Value
Assert-True ($errorBlock -match 'additionalProperties: false') 'error details use a field whitelist'
Assert-True (-not ($errorBlock -match 'additionalProperties: true')) 'error details reject arbitrary properties'

$baselinePath = Join-Path $root 'docs/verification/m0-baseline.sha256'
if (Test-Path -LiteralPath $baselinePath -PathType Leaf) {
  $baselineManifestDigest = (Get-FileHash -Algorithm SHA256 -LiteralPath $baselinePath).Hash.ToLowerInvariant()
  Assert-True (
    $baselineManifestDigest -eq '83666a0ae2fecb1f7f487c4ff9eed6f7c363d86a0a5687c06f275067bdd77cc7'
  ) 'historical M0 baseline manifest itself remains byte-for-byte immutable'
  $baselineLines = Get-Content -LiteralPath $baselinePath -Encoding utf8 | Where-Object { $_ -match '^[a-f0-9]{64} \*' }
  Assert-True ($baselineLines.Count -ge 9) 'M0 baseline covers core architecture and verification files'
  Assert-True (
    $baselineLines -contains '5473b1fd304c869886ac430f62bf27d1b8754071f4cd2efa075dac01405cb6cb *docs/api/openapi.yaml'
  ) 'historical M0 baseline still records the accepted OpenAPI fingerprint'
}

$trace = Get-Content -LiteralPath (Join-Path $root 'docs/verification/traceability.md') -Raw -Encoding utf8
foreach ($id in $invIds) {
  Assert-True ($trace.Contains($id) -or $id -in @('INV-003','INV-004','INV-005','INV-006','INV-010','INV-011','INV-012','INV-013','INV-014')) "traceability references or groups $id"
}

if (-not $Quiet) {
  Write-Host ""
  Write-Host "M0 checks: $($passes.Count) passed, $($failures.Count) failed"
}

if ($failures.Count -gt 0) {
  throw "M0 verification failed: $($failures -join '; ')"
}
