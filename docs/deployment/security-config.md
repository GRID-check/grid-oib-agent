# Security Configuration Guide

## Authentication

### Enabling / Disabling Auth

The `REQUIRE_AUTH` environment variable controls whether WorkOS AuthKit login is required:

```bash
# Disabled (default): app uses "Default User", no login required
REQUIRE_AUTH=false

# Enabled: users must log in via WorkOS AuthKit
REQUIRE_AUTH=true
```

When auth is disabled, the system runs with a default unauthenticated user context. The Python backend receives no JWT tokens and operates in anonymous mode.

### WorkOS Configuration

When `REQUIRE_AUTH=true`, these variables must be set:

| Variable | Format | Example |
|----------|--------|---------|
| `WORKOS_CLIENT_ID` | `client_xxx` | `client_abc123` |
| `WORKOS_API_KEY` | `sk_live_xxx` or `sk_test_xxx` | `sk_test_abc123` |
| `WORKOS_REDIRECT_URI` | Full URL | `https://your-domain.com/api/auth/callback` |
| `WORKOS_COOKIE_PASSWORD` | 32-byte hex string | `$(openssl rand -hex 32)` |

Steps to configure:

1. Create an account at [workos.com](https://workos.com).
2. Set up AuthKit with your preferred identity provider (Google, Microsoft, etc.).
3. Configure the redirect URI in the WorkOS dashboard to match `WORKOS_REDIRECT_URI`.
4. Copy the Client ID and API Key from the WorkOS dashboard.
5. Generate a strong cookie password: `openssl rand -hex 32`.

The WorkOS session cookie is encrypted using `WORKOS_COOKIE_PASSWORD`. If this value changes, all existing sessions are invalidated.

### Cookie Password

The `WORKOS_COOKIE_PASSWORD` is used to encrypt the AuthKit session cookie. Requirements:
- Minimum 32 characters (recommended: 64 hex chars from `openssl rand -hex 32`)
- Must be stable across deployments — changing it invalidates all sessions
- Store it securely (not in version control)

## MinIO

### Default Credentials

The Docker Compose file hardcodes MinIO credentials:

```
MINIO_ROOT_USER: minioadmin
MINIO_ROOT_PASSWORD: minioadmin
```

**These must be changed in production.** The credentials are currently hardcoded in `docker-compose.yaml` and copied into the `frontend` service's environment block.

### Changing MinIO Credentials

1. Set new values in your `.env` file:
   ```bash
   MINIO_ACCESS_KEY=your-new-access-key
   MINIO_SECRET_KEY=your-new-secret-key
   ```
2. Update the `docker-compose.yaml` to reference these variables instead of hardcoded values:
   ```yaml
   MINIO_ROOT_USER: ${MINIO_ACCESS_KEY:-minioadmin}
   MINIO_ROOT_PASSWORD: ${MINIO_SECRET_KEY:-minioadmin}
   ```
3. The `minio-init` bucket creation script also uses hardcoded credentials:
   ```yaml
   command: >
     mc alias set local http://minio:9000 minioadmin minioadmin &&
     mc mb local/grid-documents --ignore-existing
   ```
   This must be updated to use environment variables.

### Network Exposure

MinIO exposes two ports:
- `9000`: S3 API (needed by aiq-agent and frontend)
- `9001`: Web console (for debugging — should not be exposed publicly)

In production, consider:
- Removing the `9001` port mapping
- Restricting the `9000` port to internal Docker networking only (remove the port mapping if only internal services need it)
- Adding TLS via a reverse proxy

## API Keys

### Required Keys

| Key | Production Format | Dev Format | Purpose |
|-----|------------------|------------|---------|
| `KIMI_API_KEY` | `sk-...` (Kimi) | `sk-kimi-...` | LLM inference |
| `TAVILY_API_KEY` | `tvly-...` | `tvly-dev-...` | Web search |
| `OPENROUTER_API_KEY` | `sk-or-...` | `sk-or-...` | Embedding models (workaround) |

### Optional Keys

| Key | Production Format | Purpose |
|-----|------------------|---------|
| `SERPER_API_KEY` | Standard API key | Google search fallback |
| `MODAL_TOKEN_ID` | Standard token ID | Modal sandbox integration |
| `MODAL_TOKEN_SECRET` | Standard secret | Modal sandbox integration |
| `LANGCHAIN_API_KEY` | `ls_...` | LangSmith tracing |
| `WANDB_API_KEY` | Standard API key | Experiment tracking |
| `JINA_API_KEY` | Standard API key | Evaluation |

### Key Security Notes

- For production Tavily keys, use the format `tvly-...` (not `tvly-dev-...`). Dev keys are rate-limited.
- For production WorkOS API keys, use `sk_live_...` (not `sk_test_...`). Test keys do not process real authentication.
- API keys are passed to containers via environment variables. They are visible in `docker inspect` output if the container is inspected.

## GRID_ADMIN_TOKEN

The admin token protects privileged endpoints:

```bash
GRID_ADMIN_TOKEN=change-me-in-production
```

This is a simple bearer token. Change it from the default before deploying to production. The token is sent in the `Authorization: Bearer <token>` header.

## NVIDIA API Key Workaround

### Current State

The system uses a workaround for VLM and embedding features:

- LlamaIndex's `NVIDIAEmbedding` class reads `NVIDIA_API_KEY` from the environment
- In the local development `.env`, `NVIDIA_API_KEY` is set to the same value as `OPENROUTER_API_KEY`
- This works because the embedding base URL is overridden via `AIQ_EMBED_BASE_URL` to point at OpenRouter instead of NVIDIA

### What's Needed For VLM Features

Vision-Language Model features (table extraction, image extraction, chart extraction) require a **real NVIDIA NGC API key**:

```bash
AIQ_EXTRACT_TABLES=true
AIQ_EXTRACT_IMAGES=true
AIQ_EXTRACT_CHARTS=true
AIQ_VLM_MODEL=nvidia/nemotron-nano-12b-v2-vl
AIQ_VLM_BASE_URL=https://integrate.api.nvidia.com/v1
```

To obtain an NVIDIA API key:
1. Sign up at [build.nvidia.com](https://build.nvidia.com)
2. Generate an API key from the NVIDIA API Console
3. For production, set `NVIDIA_API_KEY` to the real key

## PostgreSQL

### Default Credentials

```yaml
POSTGRES_USER: aiq
POSTGRES_PASSWORD: aiq_dev
POSTGRES_DB: aiq_jobs
```

**These are development credentials.** In production:
- Use a strong password (32+ characters, mixed case, special characters)
- Do not use default database names that reveal application structure
- Consider using Docker secrets or a secrets manager instead of environment variables

### Network Exposure

Port `5432` is mapped to the host by default. In production:
- Remove the port mapping to prevent external access
- Or restrict access to specific IP ranges via firewall

## Secrets Management

### Current State

| Secret | Location | Protection |
|--------|----------|------------|
| API keys | `deploy/.env` (git-ignored) | File permissions |
| MinIO credentials | Hardcoded in `docker-compose.yaml` | None (in git) |
| WorkOS secrets | `.env` variables | File permissions |
| Database password | Hardcoded in `docker-compose.yaml` and `init-db.sql` | None (in git) |
| Cookie password | `.env` variable | File permissions |

### Recommendations for Production

1. **Externalize all credentials from Compose files**: Move MinIO credentials and database passwords from `docker-compose.yaml` into environment variables referenced as `${VAR}`.
2. **Use a secrets manager**: For production deployments, use Docker secrets, HashiCorp Vault, or a cloud-native secrets manager.
3. **Rotate credentials regularly**: API keys and passwords should have rotation policies.
4. **Audit `.env` permissions**: Ensure `deploy/.env` is readable only by the user running Docker (`chmod 600`).
5. **Use separate API keys per environment**: Production and development should use different keys.
6. **Enable WorkOS Auth in production**: Set `REQUIRE_AUTH=true` and configure WorkOS properly.
7. **Remove default admin tokens**: Change `GRID_ADMIN_TOKEN` from `change-me-in-production`.
8. **Review the MinIO init script**: The `minio-init` service uses hardcoded credentials. For production, pass credentials via environment variables or use IAM roles if deploying on cloud infrastructure.

### TLS / HTTPS

The current Docker Compose setup does not include TLS termination. In production:

- Add a reverse proxy (nginx, Traefik, Caddy) in front of the `frontend` service
- Configure the proxy to handle TLS termination
- Update `WORKOS_REDIRECT_URI` to use the `https://` scheme
- MinIO also supports TLS when configured with proper certificates
