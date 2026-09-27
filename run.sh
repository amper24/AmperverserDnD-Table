#!/usr/bin/env bash
# Запуск DnD Table на Linux/macOS (в т.ч. в Pterodactyl python-egg).
# Переменные окружения (или файл .env): DATABASE_URL, PORT, SMTP_* — см. .env.example
set -e
cd "$(dirname "$0")"

PY=${PYTHON:-python3}
if ! command -v "$PY" >/dev/null 2>&1; then PY=python; fi

# Виртуальное окружение (если нельзя создать — ставим в --user, как на птеродактиле)
if [ -z "$NO_VENV" ]; then
  if [ ! -d .venv ]; then "$PY" -m venv .venv 2>/dev/null || true; fi
  if [ -f .venv/bin/activate ]; then . .venv/bin/activate; PY=python; fi
fi

echo "[*] Установка зависимостей..."
"$PY" -m pip install -q --disable-pip-version-check -r requirements.txt 2>/dev/null || "$PY" -m pip install -q --user -r requirements.txt

if [ ! -f .env ] && [ -z "$DATABASE_URL" ]; then
  echo "[*] .env не найден — используется SQLite (data/dnd.db). Для MySQL скопируйте .env.example в .env"
  export DATABASE_URL="sqlite+aiosqlite:///./data/dnd.db"
fi
# Pterodactyl передаёт порт через SERVER_PORT
export PORT=${PORT:-${SERVER_PORT:-8080}}
export HOST=${HOST:-0.0.0.0}

echo "[*] Старт на http://$HOST:$PORT"
exec "$PY" -m app.main
