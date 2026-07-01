# AI-Q Blueprint UI - Docker Deployment

This directory contains the Dockerfile to build and deploy the AI-Q Blueprint UI as a Docker container.

## Architecture

The UI container acts as a **full proxy** between the browser and backend:

```
Browser  -->  UI Container (HTTP + WebSocket Proxy)  -->  Backend
```

**All traffic flows through the UI container:**
- HTTP API requests -> `/api/*` routes -> Backend
- WebSocket connections -> `/websocket` proxy -> Backend

**Benefits:**
- Backend does not need public exposure
- Single ingress point for security
- Runtime configurable backend URL

## Quick Start

### 1. Build the Image

From the **`frontends/ui/`** directory:

```bash
docker build -f deploy/Dockerfile -t aiq-blueprint-ui:latest .
```

### 2. Run the Container

**Without authentication (development/testing):**

```bash
docker run -p 3000:3000 \
  -e BACKEND_URL=http://backend:8000 \
  -e REQUIRE_AUTH=false \
  aiq-blueprint-ui:latest
```

**With WorkOS AuthKit authentication:**

```bash
docker run -p 3000:3000 \
  -e BACKEND_URL=http://backend:8000 \
  -e REQUIRE_AUTH=true \
  -e WORKOS_CLIENT_ID=client_xxx \
  -e WORKOS_API_KEY=sk_test_xxx \
  -e WORKOS_REDIRECT_URI=https://your-domain.com/api/auth/callback \
  -e WORKOS_COOKIE_PASSWORD=$(openssl rand -hex 32) \
  aiq-blueprint-ui:latest
```

## Environment Variables

All environment variables are **runtime configurable** - no rebuild needed when changed.

### Backend

| Variable | Default | Description |
|----------|---------|-------------|
| `BACKEND_URL` | `http://localhost:8000` | Backend API URL |

### Authentication

| Variable | Default | Description |
|----------|---------|-------------|
| `REQUIRE_AUTH` | `false` | Set to `true` to require WorkOS AuthKit login (default user when false) |

### WorkOS AuthKit (required when `REQUIRE_AUTH=true`)

| Variable | Description |
|----------|-------------|
| `WORKOS_CLIENT_ID` | WorkOS client ID |
| `WORKOS_API_KEY` | WorkOS API key |
| `WORKOS_REDIRECT_URI` | AuthKit callback URL (e.g. `http://localhost:3000/api/auth/callback`) |
| `WORKOS_COOKIE_PASSWORD` | 32-byte random string used to encrypt the AuthKit session cookie |

## Docker Compose Example

```yaml
services:
  frontend:
    image: aiq-blueprint-ui:latest
    environment:
      - BACKEND_URL=http://backend:8000
      - REQUIRE_AUTH=${REQUIRE_AUTH:-false}
      - WORKOS_CLIENT_ID=${WORKOS_CLIENT_ID}
      - WORKOS_API_KEY=${WORKOS_API_KEY}
      - WORKOS_REDIRECT_URI=${WORKOS_REDIRECT_URI:-http://localhost:3000/api/auth/callback}
      - WORKOS_COOKIE_PASSWORD=${WORKOS_COOKIE_PASSWORD}
    ports:
      - "3000:3000"
    depends_on:
      - backend
```

## Networking

### Connecting to Host Services

When running in Docker and connecting to services on the host machine:

- **macOS/Windows:** Use `host.docker.internal`
- **Linux:** Use `--network=host` or configure Docker networking

```bash
docker run -p 3000:3000 \
  -e BACKEND_URL=http://host.docker.internal:8000 \
  -e REQUIRE_AUTH=false \
  aiq-blueprint-ui:latest
```

## Troubleshooting

### Cannot connect to backend

1. Verify `BACKEND_URL` is correct
2. Use `host.docker.internal` for host services (macOS/Windows)
3. Ensure backend is bound to `0.0.0.0`, not `127.0.0.1`
4. Check Docker network configuration

### Authentication not working

1. Verify `REQUIRE_AUTH` is set to `true`.
2. Check that `WORKOS_CLIENT_ID`, `WORKOS_API_KEY`, `WORKOS_REDIRECT_URI`, and `WORKOS_COOKIE_PASSWORD` are set.
3. Ensure the `WORKOS_REDIRECT_URI` registered in the WorkOS dashboard matches the container's public callback URL (`/api/auth/callback`).
4. Verify the WorkOS API key has permission to read sessions and organizations.

### Container won't start

1. Check logs: `docker logs <container-id>`
2. Verify all required environment variables are set
3. Ensure port 3000 is not in use

## Image Details

- **Base:** `nvcr.io/nvidia/base/ubuntu:jammy-20251013`
- **Node.js:** 22.x (via NodeSource)
- **User:** `nextjs` (uid 1001)
- **Port:** 3000
