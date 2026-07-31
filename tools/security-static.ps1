param(
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$violations = [System.Collections.Generic.List[string]]::new()

function Add-Violation([string]$Rule, [string]$File) {
  $violations.Add("$Rule in $File")
}

$sourceRoots = [System.Collections.Generic.List[string]]::new()
foreach ($projectRoot in @('apps', 'packages')) {
  foreach ($project in Get-ChildItem (Join-Path $root $projectRoot) -Directory) {
    foreach ($sourceName in @('src', 'miniprogram')) {
      $candidate = Join-Path $project.FullName $sourceName
      if (Test-Path -LiteralPath $candidate -PathType Container) {
        $sourceRoots.Add($candidate)
      }
    }
  }
}

$sourceFiles = $sourceRoots |
  ForEach-Object { Get-ChildItem -LiteralPath $_ -File -Recurse } |
  Where-Object { $_.Extension -in @('.ts', '.tsx', '.js', '.mjs', '.cjs') }

$rules = @(
  @{ Name = 'dynamic eval'; Pattern = '(?<![A-Za-z])eval\s*\(' },
  @{ Name = 'dynamic Function constructor'; Pattern = 'new\s+Function\s*\(' },
  @{ Name = 'shell command execution'; Pattern = '\b(?:exec|execSync)\s*\(' },
  @{ Name = 'weak cryptographic hash'; Pattern = 'createHash\s*\(\s*["''](?:md5|sha1)["'']' },
  @{ Name = 'disabled TLS verification'; Pattern = 'rejectUnauthorized\s*:\s*false' },
  @{ Name = 'unstructured console output'; Pattern = 'console\.(?:log|debug|info|warn|error)\s*\(' },
  @{ Name = 'unsafe raw SQL in application code'; Pattern = '\$(?:queryRawUnsafe|executeRawUnsafe)\s*\(' }
)

foreach ($file in $sourceFiles) {
  $content = Get-Content -LiteralPath $file.FullName -Raw -Encoding utf8
  foreach ($rule in $rules) {
    if ($content -match $rule.Pattern) {
      Add-Violation $rule.Name $file.FullName.Substring($root.Length + 1)
    }
  }
}

$unexpectedEnvironmentFiles = Get-ChildItem $root -File -Force -Filter '.env*' |
  Where-Object { $_.Name -ne '.env.example' }
foreach ($projectRoot in @('apps', 'packages', 'infra')) {
  foreach ($project in Get-ChildItem (Join-Path $root $projectRoot) -Directory) {
    foreach ($sourceName in @('src', 'miniprogram', 'prisma', 'docker', 'terraform')) {
      $candidate = Join-Path $project.FullName $sourceName
      if (Test-Path -LiteralPath $candidate -PathType Container) {
        $unexpectedEnvironmentFiles += Get-ChildItem $candidate -File -Recurse -Force -Filter '.env*' |
          Where-Object { $_.Name -ne '.env.example' }
      }
    }
  }
}
foreach ($file in $unexpectedEnvironmentFiles) {
  Add-Violation 'unexpected environment file' $file.FullName.Substring($root.Length + 1)
}

if ($violations.Count -gt 0) {
  foreach ($violation in $violations) {
    Write-Host "FAIL  $violation" -ForegroundColor Red
  }
  throw "Static security scan failed with $($violations.Count) violation(s)"
}

if (-not $Quiet) {
  Write-Host "Static security scan: $($sourceFiles.Count) source files checked, 0 violations"
}
