@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-Silt.ps1"
echo.
echo Silt has stopped. If the page above shows an error, that is the reason.
pause
