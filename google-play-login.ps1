$ErrorActionPreference = "Stop"

& (Join-Path $PSScriptRoot "scripts\run-google-play-login-env.ps1") @args
