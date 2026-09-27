@echo off
chcp 65001 >nul
REM Запуск DnD Table на Windows. Требуется Python 3.10+ (https://python.org, отметьте "Add to PATH").
cd /d "%~dp0"

where python >nul 2>nul || (echo [!] Python не найден. Установите Python 3.10+ и добавьте в PATH. & pause & exit /b 1)

if not exist .venv (
  echo [*] Создание виртуального окружения...
  python -m venv .venv
)
call .venv\Scripts\activate.bat

echo [*] Установка зависимостей...
python -m pip install -q --disable-pip-version-check -r requirements.txt

if not exist .env (
  if "%DATABASE_URL%"=="" (
    echo [*] .env не найден — используется SQLite ^(data\dnd.db^). Для MySQL скопируйте .env.example в .env
    set DATABASE_URL=sqlite+aiosqlite:///./data/dnd.db
  )
)
if "%PORT%"=="" set PORT=8080
if "%HOST%"=="" set HOST=0.0.0.0

echo [*] Старт на http://localhost:%PORT%
start "" http://localhost:%PORT%
python -m app.main
pause
