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
COPY scripts/ ./scripts/
# The spatial engine behind `ifc_measure` (ADR-0045 amendment / roadmap §13b).
# It is not a uv workspace member — its dependency set (IfcOpenShell, shapely)
# has nothing to do with the rest of the backend — so it is copied and installed
# on its own below.
COPY packages/ifc-spatial-py/ ./packages/ifc-spatial-py/
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
    && uv pip install --no-deps -e ./sources/ris_adapter \
    && uv pip install --no-deps -e "./sources/knowledge_layer[all]" \
    && uv pip install --no-deps -e ./frontends/aiq_api \
    && uv pip install "psycopg[binary]>=3.0.0" "beautifulsoup4>=4.12.0"

# The spatial engine, installed WITH its dependencies (unlike the workspace
# packages above, whose deps come from the lockfile). Deliberately a separate
# layer and deliberately not in `uv.lock`: IfcOpenShell ships prebuilt wheels
# per platform, it is the only consumer of shapely in this image, and a
# deployment that never answers a geometric question should be able to drop
# this one line. `ifc_measure` degrades to a plain refusal when the import
# fails — it never reports a missing engine as an unreadable building.
# `[ids]` pulls ifctester for the IDS shopping-list export. Optional in the
# package because the tool degrades to a named refusal without it; installed
# here because on THIS deployment the capability is wanted.
RUN uv pip install -e './packages/ifc-spatial-py[ids]'

RUN /app/.venv/bin/python -c "import aiq_api; import knowledge_layer; import ris_adapter.register; print('✓ Base packages installed')" \
    && /app/.venv/bin/python -c "import ifc_spatial.tools; print('✓ Spatial engine installed')"

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

USER 1000:1000

ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
ENV PATH="/app/.venv/bin:$PATH"
ENV APP_ENV=production

EXPOSE 8000

ENTRYPOINT ["python", "/app/deploy/entrypoint.py"]
