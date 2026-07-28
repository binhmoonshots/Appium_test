$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "appium-env.ps1")

Set-Location (Join-Path $PSScriptRoot "..")
node ./scripts/google-play-login @args
