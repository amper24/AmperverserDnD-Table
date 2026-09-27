#!/usr/bin/env bash
# Запуск DnD Table на Linux/macOS.
# Если есть готовый бинарник (target/release/dnd-table или ./dnd-table) — запускает его,
# иначе собирает через cargo (нужен Rust: https://rustup.rs).
set -e
cd "$(dirname "$0")"
export PORT="${PORT:-${SERVER_PORT:-8080}}"
[ -f .env ] || { echo "[*] .env не найден — используется SQLite (data/dnd.db). Для MySQL: cp .env.example .env"; }

if [ -x ./dnd-table ]; then exec ./dnd-table; fi
if [ -x target/release/dnd-table ] && [ -z "$REBUILD" ]; then exec target/release/dnd-table; fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "[!] cargo не найден. Установите Rust: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
  echo "    или скачайте готовый бинарник из GitHub Releases и положите рядом как ./dnd-table"
  exit 1
fi
echo "[*] Сборка (release)..."
cargo build --release
exec target/release/dnd-table
