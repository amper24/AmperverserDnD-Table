@echo off
chcp 65001 >nul
REM Запуск DnD Table на Windows.
REM Если рядом есть dnd-table.exe (из GitHub Releases) — запускается он, иначе сборка через cargo (https://rustup.rs).
cd /d "%~dp0"
if "%PORT%"=="" set PORT=8080
if not exist .env echo [*] .env не найден — используется SQLite (data\dnd.db). Для MySQL скопируйте .env.example в .env

if exist dnd-table.exe (
  start "" http://localhost:%PORT%
  dnd-table.exe
  goto :end
)
if exist target\release\dnd-table.exe (
  start "" http://localhost:%PORT%
  target\release\dnd-table.exe
  goto :end
)
where cargo >nul 2>nul || (echo [!] cargo не найден. Установите Rust с https://rustup.rs или скачайте dnd-table.exe из Releases. & pause & exit /b 1)
echo [*] Сборка (release)...
cargo build --release || (pause & exit /b 1)
start "" http://localhost:%PORT%
target\release\dnd-table.exe
:end
pause
