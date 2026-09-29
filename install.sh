#!/usr/bin/env bash
# Установка одной командой:
#   curl -fsSL https://raw.githubusercontent.com/amper24/AmperverserDnD-Table/main/install.sh | bash
# Переменные: DND_DIR (папка), DND_MODE=docker|binary|cargo (auto: docker → готовый бинарник → cargo), PORT
set -e
REPO_URL="https://github.com/amper24/AmperverserDnD-Table"
DIR="${DND_DIR:-$HOME/dnd-table}"
MODE="${DND_MODE:-auto}"

echo "==> Amperverser DnD Table — установка в $DIR"
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only; else git clone --depth 1 "$REPO_URL.git" "$DIR"; fi
cd "$DIR"

if [ "$MODE" = "auto" ]; then
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then MODE=docker
  elif command -v cargo >/dev/null 2>&1; then MODE=cargo
  else MODE=binary; fi
fi

if [ ! -f .env ]; then
  cp .env.example .env
  [ -n "$PORT" ] && sed -i.bak "s/^#* *PORT=.*/PORT=$PORT/" .env && rm -f .env.bak
  if [ "$MODE" = "docker" ]; then
    MP=$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')
    printf "\nMYSQL_PASSWORD=%s\nMYSQL_ROOT_PASSWORD=%s\n" "$MP" "$MP" >> .env
  fi
fi

case "$MODE" in
  docker)
    echo "==> Запуск через Docker Compose (MySQL + приложение)"
    docker compose up -d --build
    echo "==> Готово: http://localhost:${PORT:-8080}   Логи: docker compose -f $DIR/docker-compose.yml logs -f app" ;;
  binary)
    echo "==> Скачивание готового бинарника из GitHub Releases"
    ARCH=$(uname -m); OS=$(uname -s | tr '[:upper:]' '[:lower:]')
    case "$OS-$ARCH" in
      linux-x86_64) ASSET="dnd-table-linux-x86_64" ;;
      linux-aarch64) ASSET="dnd-table-linux-aarch64" ;;
      darwin-arm64|darwin-aarch64) ASSET="dnd-table-macos-aarch64" ;;
      darwin-x86_64) ASSET="dnd-table-macos-x86_64" ;;
      *) echo "[!] Нет сборки для $OS-$ARCH, установите Rust (https://rustup.rs) и запустите ./run.sh"; exit 1 ;;
    esac
    curl -fL "$REPO_URL/releases/latest/download/$ASSET" -o dnd-table && chmod +x dnd-table
    echo "==> Запуск (SQLite). Для MySQL пропишите DATABASE_URL в $DIR/.env"
    exec ./run.sh ;;
  cargo)
    echo "==> Сборка через cargo (SQLite). Для MySQL пропишите DATABASE_URL в $DIR/.env"
    exec ./run.sh ;;
esac
