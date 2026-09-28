@echo off
chcp 65001 >nul 2>nul
setlocal EnableExtensions
REM ---------------------------------------------------------------------------
REM Edge Tablet - Windows installer (no Rust required).
REM Downloads dnd-table.exe from the latest GitHub Release next to this file and
REM then hands over to run.bat.
REM
REM Variables:
REM   DND_DIR=<path>   install into a folder of your choice (default: here)
REM   PORT=8080        listening port
REM   NO_BROWSER=1     do not open the browser
REM   NO_PAUSE=1       do not wait for a key press at the end
REM
REM Keep this file ASCII-only and with CRLF line endings (see run.bat).
REM ---------------------------------------------------------------------------
set "HERE=%~dp0"
if not defined DND_DIR set "DND_DIR=%HERE%"
if "%DND_DIR:~-1%"=="\" set "DND_DIR=%DND_DIR:~0,-1%"
if not defined PORT set "PORT=8080"
set "URL=https://github.com/amper24/AmperverserDnD-Table/releases/latest/download/dnd-table-windows-x86_64.exe"

echo [*] Edge Tablet installer
echo     folder : %DND_DIR%
echo     source : %URL%

if not exist "%DND_DIR%" mkdir "%DND_DIR%"
if not exist "%DND_DIR%" goto :err "cannot create %DND_DIR%"

where powershell >nul 2>nul
if errorlevel 1 goto :err "PowerShell was not found - download dnd-table-windows-x86_64.exe manually from https://github.com/amper24/AmperverserDnD-Table/releases"

echo [*] Downloading dnd-table.exe...
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $ProgressPreference='SilentlyContinue'; try { Invoke-WebRequest -Uri '%URL%' -OutFile '%DND_DIR%\dnd-table.exe' -UseBasicParsing } catch { Write-Host $_.Exception.Message; exit 1 }"
if errorlevel 1 goto :err "download failed - check the network/proxy, or get the .exe from the Releases page by hand"
if not exist "%DND_DIR%\dnd-table.exe" goto :err "download failed - dnd-table.exe is missing"

echo [OK] Saved %DND_DIR%\dnd-table.exe
copy /y "%HERE%run.bat" "%DND_DIR%\run.bat" >nul 2>nul

echo [*] Starting the server on port %PORT% (Ctrl+C or the console command "stop" to quit)
cd /d "%DND_DIR%"
REM run.bat must not pause on its own - this script pauses once at the end.
set "NO_PAUSE=1"
call "%DND_DIR%\run.bat" %*
set "RC=%ERRORLEVEL%"
if /i not "%NO_PAUSE%"=="1" pause
exit /b %RC%

:err
echo.
echo [!] %~1
if /i not "%NO_PAUSE%"=="1" pause
exit /b 1
