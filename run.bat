@echo off
chcp 65001 >nul
setlocal
REM Запуск Edge Tablet на Windows.
REM Порядок: dnd-table.exe рядом (из GitHub Releases) -> уже собранный target\release\dnd-table.exe -> сборка через cargo (https://rustup.rs).
REM Переменные: PORT (по умолчанию 8080), NO_BROWSER=1 — не открывать браузер, NO_PAUSE=1 — не ждать нажатия клавиши в конце.
cd /d "%~dp0"
if "%PORT%"=="" set PORT=8080
if not exist data mkdir data
if not exist .env echo [*] .env не найден — используется SQLite (data\dnd.db). Для MySQL скопируйте .env.example в .env

set "EXE="
if exist dnd-table.exe set "EXE=dnd-table.exe"
if not defined EXE if exist target\release\dnd-table.exe set "EXE=target\release\dnd-table.exe"

if not defined EXE (
  where cargo >nul 2>nul
  if errorlevel 1 (
    echo [!] cargo не найден. Установите Rust: https://rustup.rs  ^(при установке выберите msvc-toolchain и поставьте Visual Studio Build Tools, если предложит^),
    echo     либо скачайте dnd-table.exe со страницы Releases и положите рядом с этим файлом.
    goto :fail
  )
  echo [*] Сборка ^(release^)... первый раз занимает несколько минут.
  cargo build --release
  if errorlevel 1 (
    echo [!] Сборка не удалась. Частая причина — нет компоновщика: установите "Visual Studio Build Tools" с компонентом "Desktop development with C++" и перезапустите.
    goto :fail
  )
  set "EXE=target\release\dnd-table.exe"
)

echo [*] Запуск %EXE% на порту %PORT%. В этой консоли работают команды: help, users list, users make-root ^<email^>, stop
if "%~1"=="" if not "%NO_BROWSER%"=="1" start "" http://localhost:%PORT%
"%EXE%" %*
set "RC=%ERRORLEVEL%"
if not "%NO_PAUSE%"=="1" pause
exit /b %RC%

:fail
if not "%NO_PAUSE%"=="1" pause
exit /b 1
