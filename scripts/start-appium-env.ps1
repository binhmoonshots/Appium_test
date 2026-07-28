$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "appium-env.ps1")

Set-Location (Join-Path $PSScriptRoot "..")
npx.cmd appium --allow-insecure=uiautomator2:adb_shell
