@echo off
rem Build DnD-Tablet for Windows only into dist\ (no GitHub CLI needed).
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build.ps1" -Platforms windows
set "CODE=%ERRORLEVEL%"
echo.
if "%CODE%"=="0" (echo Build finished: dist\ ) else (echo Build failed, code %CODE%.)
pause
exit /b %CODE%