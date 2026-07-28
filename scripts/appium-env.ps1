param(
  [switch]$Quiet
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$androidUserHome = Join-Path $repoRoot ".android"
New-Item -ItemType Directory -Force -Path $androidUserHome | Out-Null
$env:ANDROID_USER_HOME = $androidUserHome

function First-ExistingPath {
  param([string[]]$Paths)

  foreach ($item in $Paths) {
    if ($item -and (Test-Path -LiteralPath $item)) {
      return (Resolve-Path -LiteralPath $item).Path
    }
  }

  return $null
}

function First-ChildPath {
  param(
    [string[]]$Parents,
    [string]$Pattern
  )

  foreach ($parent in $Parents) {
    if ($parent -and (Test-Path -LiteralPath $parent)) {
      $child = Get-ChildItem -LiteralPath $parent -Directory -Filter $Pattern -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending |
        Select-Object -First 1
      if ($child) {
        return $child.FullName
      }
    }
  }

  return $null
}

$sdkRoot = First-ExistingPath @(
  $env:ANDROID_HOME,
  $env:ANDROID_SDK_ROOT,
  (Join-Path $env:LOCALAPPDATA "Android\Sdk"),
  "C:\Android\Sdk",
  "C:\Tool\android-sdk",
  "C:\Tool\platform-tools-latest-windows"
)

if ($sdkRoot) {
  $env:ANDROID_HOME = $sdkRoot
  $env:ANDROID_SDK_ROOT = $sdkRoot

  $sdkPathEntries = @(
    (Join-Path $sdkRoot "platform-tools"),
    (Join-Path $sdkRoot "emulator"),
    (Join-Path $sdkRoot "cmdline-tools\latest\bin"),
    (Join-Path $sdkRoot "tools\bin")
  ) | Where-Object { Test-Path -LiteralPath $_ }

  if ($sdkPathEntries.Count -gt 0) {
    $env:PATH = ($sdkPathEntries -join ";") + ";" + $env:PATH
  }
}

$jdkRoot = First-ExistingPath @(
  $env:JAVA_HOME,
  (First-ChildPath @("C:\Program Files\Eclipse Adoptium", "C:\Program Files\Java") "jdk*"),
  (First-ChildPath @("C:\Program Files\Microsoft") "jdk*"),
  "C:\Program Files\Android\Android Studio\jbr"
)

if ($jdkRoot) {
  $env:JAVA_HOME = $jdkRoot
  $javaBin = Join-Path $jdkRoot "bin"
  if (Test-Path -LiteralPath $javaBin) {
    $env:PATH = $javaBin + ";" + $env:PATH
  }
}

if (-not $Quiet) {
  Write-Host "Appium environment"
  Write-Host "  ANDROID_HOME=$env:ANDROID_HOME"
  Write-Host "  ANDROID_SDK_ROOT=$env:ANDROID_SDK_ROOT"
  Write-Host "  ANDROID_USER_HOME=$env:ANDROID_USER_HOME"
  Write-Host "  JAVA_HOME=$env:JAVA_HOME"

  $adb = Get-Command adb -ErrorAction SilentlyContinue
  $java = Get-Command java -ErrorAction SilentlyContinue
  $emulator = Get-Command emulator -ErrorAction SilentlyContinue

  Write-Host "  adb=$($adb.Source)"
  Write-Host "  java=$($java.Source)"
  Write-Host "  emulator=$($emulator.Source)"

  if (-not $sdkRoot) {
    Write-Warning "Android SDK was not found. Install Android SDK or set ANDROID_HOME."
  }
  if (-not $jdkRoot) {
    Write-Warning "JDK was not found. Install JDK 17+ or set JAVA_HOME."
  }
}
