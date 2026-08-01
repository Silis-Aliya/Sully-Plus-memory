@echo off
cd /d "%~dp0"
echo Starting SullyOS Memory Hub...
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found in PATH.
  echo Please start from a terminal that can run node, or install Node.js.
  echo.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found in PATH.
  echo Please start from a terminal that can run npm.
  echo.
  pause
  exit /b 1
)

echo Open http://localhost:8787 after the server starts.
echo.

powershell -NoProfile -Command "$c=Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue; if($c){ exit 0 } else { exit 1 }" >nul 2>nul
if not errorlevel 1 (
  echo Memory Hub is already running:
  echo http://localhost:8787
  echo.
  start "" "http://localhost:8787"
  pause
  exit /b 0
)

npm start
echo.
echo Memory Hub stopped or failed to start.
pause
