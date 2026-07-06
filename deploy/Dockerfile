# =============================================================================
# Multi-stage build for AI-Q Blueprint Backend
# =============================================================================
#
# Build targets:
#   docker build --target dev -t aiq:dev .     # Development (includes CLI)
#   docker build --target release -t aiq:prod . # Production (web only, validates env)
#
# Base images are public (Debian 12 "bookworm" slim) so the stack builds on any
# Docker host — no NVIDIA NGC registry credentials required. All LLM/embedding
# work is remote (OpenRouter over HTTP); nothing here needs a GPU or CUDA.
# The Python interpreter is a self-contained uv "python-build-standalone" build
# carried from the builder stage in /opt/uv-python + /app/.venv, so the runtime
# base only needs glibc + CA certificates. Builder and runtime share the same
# Debian/glibc lineage so wheels and the standalone interpreter stay ABI-safe.
# (Alpine is intentionally avoided: it uses musl, not glibc, and the standalone
# Python + manylinux wheels here are glibc-only.)
# =============================================================================

# =============================================================================
# Stage 1: Builder (shared between dev and release)
# =============================================================================
FROM debian:bookworm-slim AS builder

WORKDIR /app

# Install system dependencies and bootstrap Python for uv.
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y \
    tzdata \
    build-essential \
    ca-certificates \
    curl \
    git \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

ENV UV_PYTHON_INSTALL_DIR=/opt/uv-python

RUN python3 -m pip install --break-system-packages --no-cache-dir uv \
    && uv python install 3.13 \
    && UV_PYTHON_BIN="$(uv python find 3.13)" \
    && ln -sf "$UV_PYTHON_BIN" /usr/local/bin/python \
    && ln -sf "$UV_PYTHON_BIN" /usr/local/bin/python3

RUN uv venv /app/.venv --python /usr/local/bin/python

ENV VIRTUAL_ENV=/app/.venv
ENV PATH="/app/.venv/bin:$PATH"
ENV UV_PYTHON=/app/.venv/bin/python

# Copy workspace configuration and lockfile
COPY pyproject.toml uv.lock ./

# Copy all source packages
COPY src/ ./src/
COPY sources/ ./sources/
COPY frontends/aiq_api/ ./frontends/aiq_api/
COPY frontends/cli/ ./frontends/cli/
COPY frontends/debug/ ./frontends/debug/
COPY configs/ ./configs/
# Only copy runtime scripts from deploy/ — never copy the full directory
# to avoid leaking .env, Helm charts, compose files, or other dev artifacts.
COPY deploy/entrypoint.py deploy/start_web.py ./deploy/

# Install dependencies using uv sync
RUN uv sync --frozen --no-dev --no-install-workspace

# Install workspace packages (without CLI for base)
RUN uv pip install --no-deps -e . \
    && uv pip install --no-deps -e ./sources/google_scholar_paper_search \
    && uv pip install --no-deps -e ./sources/tavily_web_search \
    && uv pip install --no-deps -e ./sources/exa_web_search \
    && uv pip install --no-deps -e "./sources/knowledge_layer[all]" \
    && uv pip install --no-deps -e ./frontends/aiq_api \
    && uv pip install "psycopg[binary]>=3.0.0"

RUN /app/.venv/bin/python -c "import aiq_api; import knowledge_layer; print('✓ Base packages installed')"

RUN chmod +x /app/deploy/start_web.py \
    && mkdir -p /app/data \
    && chown -R 1000:1000 /app/data

# =============================================================================
# Stage 2: Development (includes CLI)
# =============================================================================
FROM builder AS dev-builder

# Install CLI and debug UI for development
RUN uv pip install --no-deps -e ./frontends/cli \
    && uv pip install --no-deps -e ./frontends/debug

# Install Node.js for frontend development inside the dev container
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN /app/.venv/bin/python -c "import aiq_api; import aiq_research_cli; import aiq_debug; import knowledge_layer; print('✓ All packages installed')"

# =============================================================================
# Stage: OIB knowledge seed (optional)
# =============================================================================
# Downloads a pre-generated OIB embedding snapshot (chroma_data + registry) so
# deployed environments — especially ephemeral per-PR previews — start with the
# knowledge base ready instead of re-embedding the whole corpus on first boot.
# Produce the snapshot with scripts/make_oib_seed.sh and host it somewhere the
# builder can reach, then pass its URL at build time:
#   docker build --build-arg OIB_SEED_URL=<url> ...   (Coolify: Build Variables)
# If OIB_SEED_URL is empty the image ships with an empty seed dir and the backend
# falls back to live ingestion. The tarball must contain `chroma_data/` and
# `oib_registry.json` at its top level (that is what make_oib_seed.sh produces).
FROM debian:bookworm-slim AS oib-seed
ARG OIB_SEED_URL=""
WORKDIR /opt/oib-seed
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    if [ -n "$OIB_SEED_URL" ]; then \
      curl -fsSL "$OIB_SEED_URL" -o /tmp/seed.tar.gz; \
      tar -xzf /tmp/seed.tar.gz -C /opt/oib-seed; \
      rm /tmp/seed.tar.gz; \
      echo "Baked OIB seed:"; ls -la /opt/oib-seed; \
    else \
      echo "No OIB_SEED_URL — building without a baked OIB seed (live ingestion on first boot)."; \
    fi

# =============================================================================
# Stage 3: Development runtime
# =============================================================================
FROM debian:bookworm-slim AS dev

WORKDIR /app

# Runtime OS deps: CA certs for outbound TLS (OpenRouter/Tavily), tzdata for
# timestamps. The Python interpreter itself is copied from the builder below.
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    tzdata \
    && rm -rf /var/lib/apt/lists/*

COPY --from=dev-builder /opt/uv-python /opt/uv-python
COPY --from=dev-builder /app /app

# Baked OIB knowledge seed (empty if no OIB_SEED_URL was passed). entrypoint.py
# restores it into /app/data on first boot when the KB is still empty.
COPY --from=oib-seed /opt/oib-seed /opt/oib-seed

USER 1000:1000

ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
ENV PATH="/app/.venv/bin:$PATH"

EXPOSE 8000

ENTRYPOINT ["python", "/app/deploy/entrypoint.py"]

# =============================================================================
# Stage 4: Release (production - no CLI)
# =============================================================================
FROM debian:bookworm-slim AS release

WORKDIR /app

# Runtime OS deps: CA certs for outbound TLS (OpenRouter/Tavily), tzdata for
# timestamps. The Python interpreter itself is copied from the builder below.
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    tzdata \
    && rm -rf /var/lib/apt/lists/*

# Copy from base builder (no CLI)
COPY --from=builder /opt/uv-python /opt/uv-python
COPY --from=builder /app /app

# Baked OIB knowledge seed (empty if no OIB_SEED_URL was passed). entrypoint.py
# restores it into /app/data on first boot when the KB is still empty.
COPY --from=oib-seed /opt/oib-seed /opt/oib-seed

USER 1000:1000

ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
ENV PATH="/app/.venv/bin:$PATH"
ENV APP_ENV=production

EXPOSE 8000

ENTRYPOINT ["python", "/app/deploy/entrypoint.py"]
