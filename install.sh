#!/usr/bin/env bash
# Установка одной командой:
#   curl -fsSL https://raw.githubusercontent.com/amper24/AmperverserDnD-Table/main/install.sh | bash
# Переменные: DND_DIR (куда ставить), DND_MODE=docker|python (по умолчанию docker, если он есть), PORT
set -e
REPO="https://github.com/amper24/AmperverserDnD-Table.git"
DIR="${DND_DIR:-$HOME/dnd-table}"
MODE="${DND_MODE:-auto}"

echo "==> Amperverser DnD Table — установка в $DIR"
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only; else git clone --depth 1 "$REPO" "$DIR"; fi
cd "$DIR"

if [ "$MODE" = "auto" ]; then
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then MODE=docker; else MODE=python; fi
fi

if [ ! -f .env ]; then
  cp .env.example .env
  SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  sed -i.bak "s/^SECRET_KEY=.*/SECRET_KEY=$SECRET/" .env && rm -f .env.bak
  if [ "$MODE" = "docker" ]; then
    MP=$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')
    printf "\nMYSQL_PASSWORD=%s\nMYSQL_ROOT_PASSWORD=%s\n" "$MP" "$MP" >> .env
  else
    sed -i.bak "s|^DATABASE_URL=mysql.*|# &|; s|^# DATABASE_URL=sqlite|DATABASE_URL=sqlite|" .env && rm -f .env.bak
  fi
  [ -n "$PORT" ] && sed -i.bak "s/^PORT=.*/PORT=$PORT/" .env && rm -f .env.bak
fi

if [ "$MODE" = "docker" ]; then
  echo "==> Запуск через Docker Compose (MySQL + приложение)"
  docker compose up -d --build
  echo "==> Готово: http://localhost:${PORT:-8080}   Логи: docker compose -f $DIR/docker-compose.yml logs -f app"
else
  echo "==> Docker не найден — запуск через Python (SQLite)"
  echo "    Для MySQL пропишите DATABASE_URL в $DIR/.env"
  exec ./run.sh
fi
