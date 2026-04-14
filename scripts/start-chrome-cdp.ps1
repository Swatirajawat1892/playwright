# Start Google Chrome with your normal profile + Chrome DevTools Protocol (CDP).
# Playwright can then attach (OHID_CDP_PORT) and use your extensions (e.g. VPN).
#
# IMPORTANT: Close ALL Chrome windows first (Task Manager → end chrome.exe if needed).
# Only one Chrome instance may use this user-data folder at a time.

$ErrorActionPreference = "Stop"

$ChromeExe = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $ChromeExe)) {
  Write-Error "Chrome not found at $ChromeExe. Edit scripts/start-chrome-cdp.ps1 if installed elsewhere."
  exit 1
}

$userData = Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data"
$port = if ($env:OHID_CDP_PORT) { $env:OHID_CDP_PORT.Trim() } else { "9222" }
$profileDir = if ($env:CHROME_PROFILE_DIRECTORY) { $env:CHROME_PROFILE_DIRECTORY.Trim() } else { "Default" }

Write-Host ""
Write-Host "Starting Chrome with YOUR profile + remote debugging"
Write-Host "  Executable:  $ChromeExe"
Write-Host "  User data:   $userData"
Write-Host "  Profile dir: $profileDir   (set CHROME_PROFILE_DIRECTORY for Profile 1, etc.)"
Write-Host "  CDP port:    $port         (set OHID_CDP_PORT to change)"
Write-Host ""
Write-Host "If Chrome does not open: close every Chrome window, then run this script again."
Write-Host ""

# --remote-allow-origins=* is required on recent Chrome so Playwright can connect to the CDP endpoint.
$argList = @(
  "--remote-debugging-port=$port",
  "--remote-allow-origins=*",
  "--user-data-dir=$userData",
  "--profile-directory=$profileDir",
  "--no-first-run",
  "--no-default-browser-check"
)

Start-Process -FilePath $ChromeExe -ArgumentList $argList

Write-Host "Chrome launched. Verify CDP: http://127.0.0.1:$port/json/version"
Write-Host "Then run: npm run login:ohid"
Write-Host ""
