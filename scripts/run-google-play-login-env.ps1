$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "appium-env.ps1")

Set-Location (Join-Path $PSScriptRoot "..")

$appiumHost = if ($env:APPIUM_HOST) { $env:APPIUM_HOST } else { "127.0.0.1" }
$appiumPort = if ($env:APPIUM_PORT) { $env:APPIUM_PORT } else { "4723" }
$probeHost = if ($appiumHost -eq "0.0.0.0") { "127.0.0.1" } else { $appiumHost }
$statusUri = "http://{0}:{1}/status" -f $probeHost, $appiumPort

function Test-AppiumReady {
	try {
		Invoke-RestMethod -Uri $statusUri -UseBasicParsing -TimeoutSec 2 | Out-Null
		return $true
	} catch {
		return $false
	}
}

if (-not (Test-AppiumReady)) {
	$appiumProcess = Start-Process -FilePath "npx.cmd" `
		-ArgumentList @("appium", "--allow-insecure=uiautomator2:adb_shell", "--port", $appiumPort) `
		-WorkingDirectory (Get-Location).Path `
		-PassThru

	$ready = $false
	for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
		Start-Sleep -Milliseconds 500
		if (Test-AppiumReady) {
			$ready = $true
			break
		}
		if ($appiumProcess.HasExited) {
			break
		}
	}

	if (-not $ready) {
		if (-not $appiumProcess.HasExited) {
			Stop-Process -Id $appiumProcess.Id -Force -ErrorAction SilentlyContinue
		}
		throw "Appium server did not become ready at $statusUri. Start it manually with .\appium.ps1 to see the server output."
	}
}

node ./scripts/google-play-login @args
