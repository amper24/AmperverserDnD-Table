@echo off
chcp 65001 >nul 2>nul
setlocal EnableExtensions
REM ---------------------------------------------------------------------------
REM Edge Tablet - Windows installer (no Rust required).
REM Downloads dnd-table.exe from the latest GitHub Release next to this file,
REM puts run.bat beside it and starts the server. Run it again to update to a
REM newer release - it always fetches the newest build.
REM
REM Variables:
REM   DND_DIR=<path>   install into a folder of your choice (default: here)
REM   PORT=8080        listening port
REM   NO_BROWSER=1     do not open the browser
REM   NO_PAUSE=1       do not wait for a key press at the end
REM   DND_URL=<url>    where to take dnd-table.exe from (mirror/private build/tests)
REM   DND_RUN_URL      where to take run.bat from when it is not next to this file
REM
REM Keep this file ASCII-only and with CRLF line endings (see run.bat).
REM ---------------------------------------------------------------------------
set "HERE=%~dp0"
set "REL=https://github.com/amper24/AmperverserDnD-Table/releases/latest/download"
if not defined DND_URL set "DND_URL=%REL%/dnd-table-windows-x86_64.exe"
if not defined DND_RUN_URL set "DND_RUN_URL=%REL%/run.bat"
if not defined DND_DIR set "DND_DIR=%HERE%"
if "%DND_DIR:~-1%"=="\" set "DND_DIR=%DND_DIR:~0,-1%"
if not defined PORT set "PORT=8080"
if not defined NO_PAUSE set "PAUSE_ME=1"

echo [*] Edge Tablet installer
echo     folder : %DND_DIR%
echo     source : %DND_URL%

if not exist "%DND_DIR%" mkdir "%DND_DIR%"
if not exist "%DND_DIR%" goto :err "cannot create %DND_DIR%"

where powershell >nul 2>nul
if errorlevel 1 goto :err "PowerShell was not found - download dnd-table-windows-x86_64.exe manually from https://github.com/amper24/AmperverserDnD-Table/releases"

set "EXE=%DND_DIR%\dnd-table.exe"
set "NEW=%DND_DIR%\dnd-table.exe.new"
if exist "%NEW%" del /q "%NEW%" >nul 2>nul

REM Download to *.new first: if anything goes wrong, the previously installed
REM dnd-table.exe stays intact.
echo [*] Downloading dnd-table.exe...
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $ProgressPreference='SilentlyContinue'; try { Invoke-WebRequest -Uri '%DND_URL%' -OutFile '%NEW%' -UseBasicParsing } catch { Write-Host $_.Exception.Message; exit 1 }"
if errorlevel 1 goto :err "download failed - check the network/proxy, or get the .exe from the Releases page by hand"
if not exist "%NEW%" goto :err "download failed - dnd-table.exe is missing"

REM Sanity check: a proxy/antivirus HTML page saved as .exe would fail much later
REM with a cryptic "not a valid Win32 application" error.
REM No parentheses/braces in the -Command below on purpose: keep cmd's FOR parser happy.
set "SIZE="
for /f "usebackq delims=" %%A in (`powershell -NoProfile -Command "Get-Item -LiteralPath '%NEW%' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Length"`) do set "SIZE=%%A"
if not defined SIZE set "SIZE=0"
set /a "SIZE=%SIZE%+0" >nul 2>nul
if %SIZE% LSS 1048576 goto :err "the downloaded file is only %SIZE% bytes - it is not the release build (blocked by a proxy/antivirus?)"

move /y "%NEW%" "%EXE%" >nul 2>nul
if exist "%NEW%" goto :err "cannot replace %EXE% - is the server still running? Close it and run install.bat again"
echo [OK] Saved %EXE% (%SIZE% bytes)

REM run.bat goes next to the exe: first the copy that sits next to this script
REM (git clone), then whatever is already installed, then the release asset.
if exist "%HERE%run.bat" copy /y "%HERE%run.bat" "%DND_DIR%\run.bat" >nul 2>nul
if exist "%DND_DIR%\run.bat" goto :hasrun
echo [*] run.bat not found next to the installer - downloading it...
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $ProgressPreference='SilentlyContinue'; try { Invoke-WebRequest -Uri '%DND_RUN_URL%' -OutFile '%DND_DIR%\run.bat' -UseBasicParsing } catch { Write-Host $_.Exception.Message; exit 1 }"
if not exist "%DND_DIR%\run.bat" echo [!] Warning: run.bat was not downloaded - start dnd-table.exe directly if it is missing.

:hasrun
echo [*] Starting the server on port %PORT% (Ctrl+C or the console command "stop" to quit)
cd /d "%DND_DIR%"
if not exist "%DND_DIR%\run.bat" goto :direct
REM run.bat must not pause on its own - this script pauses once at the end.
set "NO_PAUSE=1"
call "%DND_DIR%\run.bat" %*
set "RC=%ERRORLEVEL%"
goto :done

:direct
"%EXE%" %*
set "RC=%ERRORLEVEL%"

:done
if defined PAUSE_ME pause
exit /b %RC%

:err
if defined NEW if exist "%NEW%" del /q "%NEW%" >nul 2>nul
echo.
echo [!] %~1
if defined PAUSE_ME pause
exit /b 1
