@echo off
chcp 65001 >nul 2>nul
setlocal EnableExtensions
REM ---------------------------------------------------------------------------
REM Edge Tablet - Windows launcher.
REM
REM IMPORTANT: keep this file ASCII-only and with CRLF line endings.
REM cmd.exe parses a batch file with the console code page that is active while
REM it reads, so any UTF-8 (Cyrillic) text here turns into garbage tokens and
REM cmd starts "executing" random word fragments:
REM   '.' is not recognized...  /  'EXE' is not recognized...  /  garbage words
REM CRLF is enforced by .gitattributes.
REM
REM Binary lookup order:
REM   dnd-table.exe next to this file (GitHub Releases)
REM   target\release\dnd-table.exe
REM   target\debug\dnd-table.exe
REM   cargo build --release (Rust: https://rustup.rs)
REM No Rust? Run install.bat - it downloads dnd-table.exe from Releases.
REM
REM Variables:
REM   PORT=8080        listening port (overrides server.port from config.yml)
REM   NO_BROWSER=1     do not open the browser
REM   NO_PAUSE=1       do not wait for a key press at the end (used by CI)
REM   REBUILD=1        force cargo build even if a binary already exists
REM Arguments are passed through to dnd-table.exe:
REM   run.bat help
REM   run.bat users list
REM   run.bat users make-root admin@example.com
REM ---------------------------------------------------------------------------

REM cd FIRST: everything below (data\, .env, target\) is relative to the script.
cd /d "%~dp0"

REM Settings live in config.yml (created next to the exe on the first start).
REM PORT is NOT exported on purpose: that would override server.port from
REM config.yml. SHOW_PORT is only used for the messages and the browser.
set "SHOW_PORT=%PORT%"
if not defined SHOW_PORT set "SHOW_PORT=%SERVER_PORT%"
if not defined SHOW_PORT if exist "config.yml" for /f "tokens=2 delims=: " %%a in ('findstr /r /c:"^  port:" "config.yml"') do if not defined SHOW_PORT set "SHOW_PORT=%%a"
if not defined SHOW_PORT set "SHOW_PORT=8080"
if not exist "data" mkdir "data" 2>nul
if not exist "config.yml" echo [*] No config.yml yet - it will be created on the first start (SQLite in data\dnd.db by default)

set "EXE="
if exist "dnd-table.exe" set "EXE=dnd-table.exe"
if not defined EXE if exist "target\release\dnd-table.exe" set "EXE=target\release\dnd-table.exe"
REM REBUILD=1 - ignore a stale target\debug build and go straight to cargo.
if not defined EXE if /i not "%REBUILD%"=="1" if exist "target\debug\dnd-table.exe" set "EXE=target\debug\dnd-table.exe"

if defined EXE goto :run

where cargo >nul 2>nul
if errorlevel 1 goto :nocargo

echo [*] Building with cargo (release)... the first build takes a few minutes.
echo     No Rust and do not want to install it? Run install.bat instead.
cargo build --release
if errorlevel 1 goto :buildfail
set "EXE=target\release\dnd-table.exe"
if not exist "%EXE%" goto :buildfail
goto :run

:nocargo
echo.
echo [!] Neither dnd-table.exe nor cargo was found.
echo     Option A: run install.bat - it downloads dnd-table.exe from GitHub Releases
echo               and puts it next to this file. No Rust needed.
echo     Option B: install Rust from https://rustup.rs - pick the MSVC toolchain plus
echo               "Visual Studio Build Tools" when it is offered, then run run.bat again.
goto :fail

:buildfail
echo.
echo [!] cargo build failed. Usual cause: no linker. Install "Visual Studio Build
echo     Tools" with the "Desktop development with C++" component and try again,
echo     or just run install.bat to get a ready-made dnd-table.exe.
goto :fail

:run
netstat -ano 2>nul | findstr /r /c:":%SHOW_PORT% .*LISTENING" >nul
if not errorlevel 1 echo [!] Warning: port %SHOW_PORT% looks busy. Something may already be listening on it - change server.port in config.yml or set PORT=8081

echo [*] Starting %EXE% on port %SHOW_PORT% (settings: config.yml)
echo     Console commands while it runs: help, users list, users create ^<email^> ^<pass^> --root, stats, stop
if "%~1"=="" if /i not "%NO_BROWSER%"=="1" start http://localhost:%SHOW_PORT%

"%EXE%" %*
set "RC=%ERRORLEVEL%"
if /i not "%NO_PAUSE%"=="1" pause
exit /b %RC%

:fail
if /i not "%NO_PAUSE%"=="1" pause
exit /b 1
