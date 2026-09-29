# ---- сборка ----
FROM rust:1-bookworm AS builder
WORKDIR /build
COPY Cargo.toml Cargo.lock* ./
COPY src ./src
COPY static ./static
COPY data_seed ./data_seed
RUN cargo build --release

# ---- рантайм ----
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /build/target/release/dnd-table /app/dnd-table
RUN ln -s /app/dnd-table /usr/local/bin/dnd-table
RUN mkdir -p /app/data
# config.yml создаётся при первом запуске в /app/data (смонтируйте том, чтобы он сохранялся).
# HOST/PORT заданы переменными: снаружи контейнер всегда слушает 8080 (см. HEALTHCHECK).
ENV HOST=0.0.0.0 PORT=8080 DND_CONFIG=/app/data/config.yml
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD curl -fs http://localhost:8080/api/health || exit 1
CMD ["/app/dnd-table"]
