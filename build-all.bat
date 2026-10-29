@echo off
rem Build DnD-Tablet for Windows + Linux + macOS into dist\.
rem Requires GitHub CLI for Linux/macOS (winget install --id GitHub.cli; gh auth login).
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build.ps1"
set "CODE=%ERRORLEVEL%"
echo.
if "%CODE%"=="0" (echo Build finished: dist\ ) else (echo Build failed, code %CODE%.)
pause
exit /b %CODE%